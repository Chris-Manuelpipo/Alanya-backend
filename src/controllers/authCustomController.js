const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { sendMail, renderHtmlEmail, escapeHtml } = require('../services/mailService');
const { generateAccessToken, generateRefreshToken, JWT_REFRESH_SECRET } = require('../middleware/authCustom');
const { normalize } = require('../utils/alanyaPhone');
const { generateUniquePhone } = require('../services/alanyaPhoneService');
const deviceSessionService = require('../services/deviceSessionService');
const { emitToUser } = require('../utils/userSocketRegistry');
const recoveryCode = require('../services/recoveryCodeService');
const { lookupPlace } = require('../services/ipGeoService');
const { guardDisplayNames } = require('../utils/displayNameGuard');
const { ACCOUNT_TYPE } = require('../constants/accountTypes');
const { isOfficialAccount } = require('../utils/officialAccountGuard');
const { ensureDefaultContactLists } = require('../utils/defaultContactLists');

const SALT_ROUNDS = 10;

const _selectUserWithPays = `
  SELECT u.alanyaID, u.nom, u.pseudo, u.alanyaPhone, u.email, u.idPays,
         u.avatar_url, u.bio, u.type_compte, u.account_type, u.verification_status,
         u.verified_until, up.is_online AS is_online, up.last_seen AS last_seen,
         u.genre, u.age, u.annee_naissance, u.ville, u.idVille,
         p.libelle AS pays_libelle, p.prefix AS pays_prefix
  FROM users u
  LEFT JOIN pays p ON u.idPays = p.idPays
  LEFT JOIN user_presence up ON up.alanyaID = u.alanyaID
  WHERE u.alanyaID = ?
`;

// Vocabulaire fermé du genre. `non_precise` est une valeur à part entière et non
// un NULL : « je préfère ne pas dire » est une réponse, « pas encore renseigné »
// en est une autre, et les confondre fausserait toute lecture ultérieure.
const GENRES = ['homme', 'femme', 'autre', 'non_precise'];

// L'app est interdite aux moins de 13 ans ; au-delà de 120 c'est une faute de
// frappe, pas un utilisateur.
const AGE_MIN = 13;
const AGE_MAX = 120;

/**
 * Renseigne users.ville à partir de l'IP, en arrière-plan et sans jamais faire
 * échouer l'appelant. Même contrat que la géolocalisation des sessions QR : la
 * ville est une donnée d'appoint, aucun parcours n'en dépend.
 * `ville IS NULL` dans le WHERE : on ne réécrit jamais une ville déjà connue,
 * un utilisateur en déplacement ne doit pas voir sa ville changer à chaque
 * connexion.
 */
const _resoudreVilleEnArrierePlan = (ip, alanyaID, idPays) => {
  lookupPlace(ip)
    .then(async (lieu) => {
      if (!lieu?.city) return null;
      const { lookupVilleId } = require('../services/villeService');
      const idVille = idPays ? await lookupVilleId(idPays, lieu.city) : null;
      return pool.execute(
        `UPDATE users SET ville = COALESCE(ville, ?), idVille = COALESCE(idVille, ?)
         WHERE alanyaID = ? AND ville IS NULL`,
        [lieu.city, idVille, alanyaID],
      );
    })
    .catch((error) => {
      console.warn('[ipGeo] ville non persistée:', error.message);
    });
};

const countryExists = async (idPays) => {
  const id = Number(idPays);
  if (!Number.isFinite(id) || id <= 0) return false;
  const [rows] = await pool.execute('SELECT idPays FROM pays WHERE idPays = ?', [id]);
  return rows.length > 0;
};

const _clientIp = (req) =>
  req.ip ||
  req.headers['x-forwarded-for'] ||
  req.connection?.remoteAddress ||
  'INDEFINI';

// Journalise une connexion (login, inscription, refresh) dans userAccess.
// Best-effort : ne fait jamais échouer la requête appelante.
// `device` doit être un libellé lisible (marque + modèle, ex. "Samsung SM-A715F").
const logUserAccess = async (req, alanyaID, { device, osSystem } = {}) => {
  try {
    const ipAdress = _clientIp(req);
    const ua = req.headers['user-agent'] || '';
    const os = osSystem || _osFromUserAgent(ua) || 'INDEFINI';
    await pool.execute(
      `INSERT INTO userAccess (alanyaID, device, dateLogin, ipAdress, os_system)
       VALUES (?, ?, NOW(), ?, ?)`,
      [alanyaID, device || 'INDEFINI', ipAdress, os]
    );
  } catch (error) {
    console.warn('[userAccess] insert failed:', error.message);
  }
};

const _osFromUserAgent = (ua) => {
  if (!ua) return null;
  const s = ua.toLowerCase();
  if (s.includes('android')) return 'Android';
  if (s.includes('iphone') || s.includes('ipad') || s.includes('ios')) return 'iOS';
  if (s.includes('mac os')) return 'macOS';
  if (s.includes('windows')) return 'Windows';
  if (s.includes('linux')) return 'Linux';
  return null;
};

// Génération d'un alanyaPhone unique à 8 chiffres
const generateAlanyaPhone = async () => generateUniquePhone(8);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normalizeEmail = (value) => {
  if (value == null) return null;
  const trimmed = String(value).trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
};

// Création de compte — email optionnel (uniquement utile à la récupération MDP)
const register = async (req, res) => {
  try {
    const { email, password, nom, pseudo, idPays, fcm_token, device_ID, hardware_id, device_model, os_system } = req.body;

    if (!password) {
      return res.status(400).json({ error: 'Mot de passe requis' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit faire au moins 6 caractères' });
    }

    // Voir login() : sans identifiant d'appareil, la session serait irrévocable.
    const appareilKey = String(hardware_id || device_ID || '').trim();
    if (!appareilKey || appareilKey === 'INDEFINI') {
      return res.status(400).json({
        error: 'Identifiant d\'appareil requis',
        code: 'DEVICE_ID_REQUIRED',
      });
    }

    const cleanEmail = normalizeEmail(email);
    if (cleanEmail) {
      if (!EMAIL_REGEX.test(cleanEmail)) {
        return res.status(400).json({ error: 'Email invalide' });
      }

      const [existingEmail] = await pool.execute(
        'SELECT alanyaID FROM users WHERE email = ?',
        [cleanEmail]
      );
      if (existingEmail.length > 0) {
        return res.status(409).json({ error: 'Cette adresse Email est déjà utilisée' });
      }
    }

    const alanyaPhone = await generateAlanyaPhone();
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    const resolvedIdPays = idPays != null ? Number(idPays) : 10;
    if (!(await countryExists(resolvedIdPays))) {
      return res.status(400).json({ error: 'Pays invalide' });
    }

    // Émis pour TOUT compte, avec ou sans e-mail : le client ne l'affiche qu'aux
    // comptes sans e-mail, mais un utilisateur peut retirer son e-mail de l'écran
    // de sécurité plus tard, et un compte sans voie de récupération est un compte
    // perdu. Le générer systématiquement coûte un appel crypto.
    const { code: recoveryPlain, encrypted: recoveryEncrypted } = recoveryCode.issue();

    const [result] = await pool.execute(
      `INSERT INTO users
        (nom, pseudo, alanyaPhone, email, password, idPays, avatar_url,
         fcm_token, device_ID, recovery_code_enc, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        nom        || 'Utilisateur',
        pseudo     || nom || 'AlanyaUser',
        alanyaPhone,
        cleanEmail,
        hashedPassword,
        resolvedIdPays,
        'NON DEFINI',
        fcm_token  || 'INDEFINI',
        device_ID  || 'INDEFINI',
        recoveryEncrypted,
      ]
    );

    // is_online/last_seen vivent dans user_presence (audit scalabilité,
    // fractionnement par colonnes) — semis obligatoire à la création, sinon
    // ce compte n'aurait aucune ligne de présence tant qu'il ne se connecte
    // pas en socket.
    await pool.execute(
      'INSERT INTO user_presence (alanyaID, is_online, last_seen) VALUES (?, 0, NOW())',
      [result.insertId],
    );

    await ensureDefaultContactLists(result.insertId);

    // Ville déduite de l'IP : lancée ici et jamais attendue.
    _resoudreVilleEnArrierePlan(_clientIp(req), result.insertId, resolvedIdPays);

    const appareilId = await deviceSessionService.recordLogin({
      alanyaID: result.insertId,
      deviceId: appareilKey,
      deviceName: device_model,
      platform: os_system,
      ipAddress: _clientIp(req),
      loginMethod: 'register',
    });

    if (!appareilId) {
      console.error('[Register] recordLogin a échoué — token non émis (session serait irrévocable)');
      return res.status(503).json({ error: 'Service temporairement indisponible' });
    }

    const tokenPayload = { alanyaID: result.insertId, email: cleanEmail, appareilId };
    const accessToken   = generateAccessToken(tokenPayload);
    const refreshToken  = generateRefreshToken(tokenPayload);

    const [rows] = await pool.execute(
      `SELECT u.alanyaID, u.nom, u.pseudo, u.alanyaPhone, u.email, u.avatar_url,
              up.is_online AS is_online, up.last_seen AS last_seen,
              u.genre, u.age, u.annee_naissance, u.ville
       FROM users u
       LEFT JOIN user_presence up ON up.alanyaID = u.alanyaID
       WHERE u.alanyaID = ?`,
      [result.insertId]
    );

    // Journalise l'inscription comme premier "login" dans userAccess.
    logUserAccess(req, result.insertId, {
      device: device_model || device_ID,
      osSystem: os_system,
    });

    // `recoveryCode` en clair : unique occasion de le transmettre en dehors du
    // chemin « reveal » (qui, lui, exige le mot de passe). Le client l'affiche
    // sur l'écran identifiants et ne le stocke jamais en dur.
    res.status(201).json({ user: rows[0], accessToken, refreshToken, recoveryCode: recoveryPlain });
  } catch (error) {
    console.error('[Register] ERROR:', error);
    res.status(500).json({ error: error.message || 'Registration failed' });
  }
};

// Connexion
const login = async (req, res) => {
  try {
    const { alanyaPhone, password, fcm_token, device_ID, hardware_id, device_model, os_system } = req.body;

    if (!alanyaPhone || !password) {
      return res.status(400).json({ error: 'Alanya phone et mot de passe requis' });
    }

    // Sans identifiant d'appareil, aucune ligne `appareils` n'est créée : la
    // session serait invisible dans « Appareils connectés » et donc à jamais
    // irrévocable. On refuse plutôt que d'émettre un token intraçable.
    const appareilKey = String(hardware_id || device_ID || '').trim();
    if (!appareilKey || appareilKey === 'INDEFINI') {
      return res.status(400).json({
        error: 'Identifiant d\'appareil requis',
        code: 'DEVICE_ID_REQUIRED',
      });
    }

    const phoneCanonical = normalize(alanyaPhone);

    const [rows] = await pool.execute(
      `SELECT alanyaID, nom, pseudo, alanyaPhone, email, password, avatar_url,
              genre, age, annee_naissance, ville,
              exclus, exclude_reason, delete_scheduled_at
       FROM users WHERE alanyaPhone = ?`,
      [phoneCanonical]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    const user = rows[0];

    // Ceinture et bretelles : le compte officiel n'a ni e-mail, ni mot de passe
    // connu, ni code de récupération, donc aucun identifiant exploitable. Ce
    // refus explicite tient même si l'un de ces verrous venait à sauter — et il
    // couvre les comptes officiels créés avant que la règle n'existe.
    if (await isOfficialAccount(user.alanyaID)) {
      return res.status(403).json({
        error: 'Ce compte ne permet pas la connexion',
        code: 'OFFICIAL_NOT_LOGGABLE',
      });
    }

    if (user.exclus === 1) {
      if (
        user.exclude_reason === 'self_delete_pending'
        && user.delete_scheduled_at
        && new Date(user.delete_scheduled_at).getTime() > Date.now()
      ) {
        return res.status(403).json({
          error: 'Suppression du compte en cours',
          code: 'ACCOUNT_DELETION_PENDING',
          scheduledAt: user.delete_scheduled_at,
        });
      }
      return res.status(403).json({ error: 'Compte banni' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    // Mettre à jour fcm_token et device_ID si fournis (dernier appareil connu)
    if (fcm_token || device_ID) {
      const updates = [];
      const values  = [];
      if (fcm_token) { updates.push('fcm_token = ?'); values.push(fcm_token); }
      if (device_ID) { updates.push('device_ID = ?'); values.push(device_ID); }
      values.push(user.alanyaID);
      await pool.execute(`UPDATE users SET ${updates.join(', ')} WHERE alanyaID = ?`, values);
    }

    const appareilId = await deviceSessionService.recordLogin({
      alanyaID: user.alanyaID,
      deviceId: appareilKey,
      deviceName: device_model,
      platform: os_system,
      ipAddress: _clientIp(req),
      loginMethod: 'password',
    });

    if (!appareilId) {
      console.error('[Login] recordLogin a échoué — token non émis (session serait irrévocable)');
      return res.status(503).json({ error: 'Service temporairement indisponible' });
    }

    // Rattrape les comptes créés avant l'existence de la colonne : le UPDATE
    // porte `ville IS NULL`, il ne se déclenche donc qu'une fois par compte.
    if (user.ville == null) {
      _resoudreVilleEnArrierePlan(_clientIp(req), user.alanyaID, user.idPays);
    }

    const tokenPayload = { alanyaID: user.alanyaID, email: user.email, appareilId };
    const accessToken  = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    delete user.password;
    delete user.exclus;

    // Journalise la connexion dans userAccess (best-effort).
    logUserAccess(req, user.alanyaID, {
      device: device_model || device_ID,
      osSystem: os_system,
    });

    // Signale aux autres appareils déjà connectés qu'une nouvelle connexion
    // vient d'avoir lieu sur ce compte (mot de passe, inscription ou QR).
    emitToUser(req.app.get('io'), user.alanyaID, 'auth:conflict', {
      deviceName: device_model || 'INDEFINI',
      platform: os_system || 'INDEFINI',
      loginMethod: 'password',
      at: new Date().toISOString(),
    });

    res.json({ user, accessToken, refreshToken });
  } catch (error) {
    console.error('[Login] ERROR:', error);
    res.status(500).json({ error: error.message || 'Echec de la connexion' });
  }
};

// Refresh token
const refreshToken = async (req, res) => {
  try {
    const { refreshToken: token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'refreshToken requis' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_REFRESH_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Refresh token expiré, veuillez vous reconnecter', code: 'REFRESH_EXPIRED' });
      }
      return res.status(401).json({ error: 'Refresh token invalide' });
    }

    if (decoded.type !== 'refresh') {
      return res.status(401).json({ error: 'Type de token invalide' });
    }

    // Vérifier que le user existe toujours et n'est pas banni
    const [rows] = await pool.execute(
      'SELECT alanyaID, email FROM users WHERE alanyaID = ? AND exclus = 0',
      [decoded.alanyaID]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Utilisateur non trouvé ou banni' });
    }

    // Un appareil révoqué ne doit pas pouvoir renouveler indéfiniment son
    // access token — les tokens pré-migration (sans appareilId) passent.
    if (decoded.appareilId != null) {
      const [appareilRows] = await pool.execute(
        'SELECT id FROM appareils WHERE id = ? AND alanyaID = ? AND revoked_at IS NULL',
        [decoded.appareilId, rows[0].alanyaID]
      );
      if (appareilRows.length === 0) {
        return res.status(401).json({ error: 'Appareil déconnecté', code: 'DEVICE_REVOKED' });
      }
      deviceSessionService.touchLastActive(decoded.appareilId);
    }

    const tokenPayload    = { alanyaID: rows[0].alanyaID, email: rows[0].email, appareilId: decoded.appareilId ?? null };
    const newAccessToken  = generateAccessToken(tokenPayload);
    const newRefreshToken = generateRefreshToken(tokenPayload);

    res.json({ accessToken: newAccessToken, refreshToken: newRefreshToken });
  } catch (error) {
    console.error('[RefreshToken] ERROR:', error);
    res.status(500).json({ error: 'Echec du refresh du token' });
  }
};

// Génération d'un OTP à 6 chiffres (mot de passe oublié / changement email)
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

/** Envoi OTP via le template HTML unique — seul le contenu varie. */
const sendOtpEmail = async ({
  to,
  subject,
  heading,
  intro,
  otp,
  preheader,
  footerNote,
}) => {
  const fromEmail = process.env.SMTP_FROM;
  const fromName = process.env.MAIL_FROM_NAME || 'Alanya';
  const appName = process.env.APP_NAME || 'Alanya';
  const supportEmail = process.env.SUPPORT_EMAIL || process.env.SMTP_FROM || 'support@example.com';
  const expiryMin = Number(process.env.OTP_EXPIRY_MIN || 10);

  const text = `Bonjour,\n\n` +
    `${intro}\n\n` +
    `Votre code : ${otp}\n` +
    `Ce code est valable pendant ${expiryMin} minutes.\n\n` +
    `Si vous n'êtes pas à l'origine de cette demande, ignorez ce message ou contactez le support : ${supportEmail}.\n\n` +
    `Ne partagez jamais ce code avec qui que ce soit.\n\n` +
    `Cordialement,\nL'équipe ${appName}`;

  const html = renderHtmlEmail({
    title: subject,
    preheader: preheader || `Votre code est ${otp}`,
    eyebrow: appName,
    heading,
    intro: escapeHtml(intro),
    bodyHtml: `
      <p style="text-align:center;margin:8px 0 22px 0;">
        <span class="code">${escapeHtml(otp)}</span>
      </p>
      <p style="margin-top:0;">Ce code expire dans ${expiryMin} minutes.</p>
      <p>Si vous n'avez pas demandé cette opération, ignorez ce courriel ou contactez-nous à <a href="mailto:${escapeHtml(supportEmail)}" style="color:#1f2937;font-weight:700;">${escapeHtml(supportEmail)}</a>.</p>
      <p>Ne partagez jamais ce code avec qui que ce soit.</p>`,
    accent: '#1f2937',
    footerNote: footerNote ||
      'Si vous n\'êtes pas à l\'origine de cette demande, ignorez ce message ou contactez le support.',
    supportEmail,
  });

  if (!fromEmail) {
    throw new Error("L'adresse email d'envoi est requise (SMTP_FROM dans .env)");
  }

  if (!process.env.SMTP_HOST) {
    throw new Error("Le service email n'est pas configuré");
  }

  await sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject,
    text,
    html,
  });
};

const sendPasswordResetOTP = async (email, otp) => {
  const appName = process.env.APP_NAME || 'Alanya';
  await sendOtpEmail({
    to: email,
    subject: `Réinitialisation de votre mot de passe ${appName}`,
    heading: 'Réinitialisation de votre mot de passe',
    intro: `Nous avons reçu une demande de réinitialisation du mot de passe pour le compte lié à ${email}.`,
    otp,
    preheader: `Votre code de réinitialisation est ${otp}`,
  });
};

const sendEmailChangeOTP = async (email, otp) => {
  const appName = process.env.APP_NAME || 'Alanya';
  await sendOtpEmail({
    to: email,
    subject: `Vérification de votre adresse email ${appName}`,
    heading: 'Vérification de votre adresse email',
    intro: `Nous avons reçu une demande pour associer l'adresse ${email} à votre compte ${appName}.`,
    otp,
    preheader: `Votre code de vérification est ${otp}`,
  });
};

// Envoie un OTP à l'email
const requestPasswordReset = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email requis' });
    }

    const [rows] = await pool.execute(
      'SELECT alanyaID FROM users WHERE email = ?',
      [email.toLowerCase().trim()]
    );
 
    if (rows.length === 0) {
      return res.json({ message: 'Vérifiez votre email pour le code de réinitialisation' });
    }

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // OTP valide 10 minutes

    await pool.execute(
      'UPDATE users SET reset_otp = ?, reset_otp_expires_at = ? WHERE alanyaID = ?',
      [otp, expiresAt, rows[0].alanyaID]
    );

    await sendPasswordResetOTP(email.toLowerCase().trim(), otp);

    res.json({ message: 'Vérifiez votre email pour le code de réinitialisation' });
  } catch (error) {
    console.error('[RequestPasswordReset] ERROR:', error);
    res.status(500).json({ error: error.message || 'Request failed' });
  }
};
 
// Vérifie l'OTP et retourne un token temporaire
const validateOTP = async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email et OTP requis' });
    }

    const [rows] = await pool.execute(
      'SELECT alanyaID, reset_otp, reset_otp_expires_at FROM users WHERE email = ?',
      [email.toLowerCase().trim()]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Email invalide' });
    }

    const user = rows[0];

    // Vérifier que l'OTP existe et est valide
    if (!user.reset_otp) {
      return res.status(400).json({ error: 'Aucun OTP demandé' });
    }

    if (user.reset_otp !== otp) {
      return res.status(401).json({ error: 'OTP invalide' });
    }

    if (new Date() > new Date(user.reset_otp_expires_at)) {
      return res.status(401).json({ error: 'OTP expiré' });
    }

    // Générer un token temporaire valide 15 minutes pour changer le mot de passe
    const resetToken = jwt.sign(
      { alanyaID: user.alanyaID, type: 'password_reset' },
      process.env.JWT_SECRET || 'talky-secret-key-change-in-production',
      { expiresIn: '15m' }
    );

    res.json({ resetToken, message: 'OTP validated. Use resetToken to change password' });
  } catch (error) {
    console.error('[ValidateOTP] ERROR:', error);
    res.status(500).json({ error: error.message || 'Validation failed' });
  }
};
  
// Change le mot de passe avec le reset token
const completePasswordReset = async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body;

    if (!resetToken || !newPassword) {
      return res.status(400).json({ error: 'Token de réinitialisation et nouveau mot de passe requis' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });
    }

    // Vérifier le reset token
    let decoded;
    try {
      decoded = jwt.verify(
        resetToken,
        process.env.JWT_SECRET || 'talky-secret-key-change-in-production'
      );
    } catch (err) {
      return res.status(401).json({ error: 'Token de réinitialisation invalide ou expiré' });
    }

    if (decoded.type !== 'password_reset') {
      return res.status(401).json({ error: 'Type de token invalide' });
    }

    // Hacher le nouveau mot de passe
    const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);

    // Mettre à jour le mot de passe et nettoyer l'OTP
    await pool.execute(
      'UPDATE users SET password = ?, reset_otp = NULL, reset_otp_expires_at = NULL WHERE alanyaID = ?',
      [hashedPassword, decoded.alanyaID]
    );

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('[CompletePasswordReset] ERROR:', error);
    res.status(500).json({ error: error.message || 'Reset failed' });
  }
};

// 
const resetPassword = async (req, res) => {
  console.warn('[ResetPassword] Deprecated endpoint called');
  return res.status(410).json({
    error: 'Cet endpoint est obsolète. Utilisez POST /auth/forgot-password puis POST /auth/reset-password-confirm.',
  });
};

// Profil de l'utilisateur connecté
const getMe = async (req, res) => {
  try {
    const [rows] = await pool.execute(_selectUserWithPays, [req.user.alanyaID]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error('[GetMe] ERROR:', error);
    res.status(500).json({ error: error.message });
  }
};

// Mette à jour le token FCM pour les notifications push  
const updateFcmToken = async (req, res) => {
  try {
    const token = req.body.fcmToken || req.body.fcm_token;
    const deviceId = req.body.deviceId || req.body.device_ID || req.body.device_id;
    if (!token || typeof token !== 'string' || token.length > 4096) {
      return res.status(400).json({ error: 'fcmToken requis' });
    }

    if (deviceId) {
      await pool.execute(
        'UPDATE users SET fcm_token = ?, device_ID = ? WHERE alanyaID = ?',
        [token, deviceId, req.user.alanyaID],
      );
    } else {
      await pool.execute(
        'UPDATE users SET fcm_token = ? WHERE alanyaID = ?',
        [token, req.user.alanyaID],
      );
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('[UpdateFcmToken] ERROR:', error);
    res.status(500).json({ error: error.message });
  }
};

// Met à jour les infos de l'utilisateur (nom, pseudo, bio, avatar_url, fcm_token,
// device_ID, is_online, idPays, genre, age).
// `ville` n'est volontairement PAS acceptée ici : elle est constatée depuis
// l'adresse IP, jamais déclarée — l'exposer en écriture en ferait une donnée
// arbitraire et non plus une observation.
const updateMe = async (req, res) => {
  try {
    const { nom, pseudo, bio, avatar_url, fcm_token, device_ID, is_online, idPays, genre, age } = req.body;
    const updates = [];
    const values  = [];

    if (nom)       { updates.push('nom = ?');        values.push(nom); }
    if (pseudo)    { updates.push('pseudo = ?');     values.push(pseudo); }

    const [selfRows] = await pool.execute(
      'SELECT account_type, nom, pseudo FROM users WHERE alanyaID = ?',
      [req.user.alanyaID],
    );
    const selfAccountType = selfRows[0]?.account_type ?? 0;
    const nameGuard = guardDisplayNames({
      nom: nom ?? selfRows[0]?.nom,
      pseudo: pseudo ?? selfRows[0]?.pseudo,
      accountType: selfAccountType,
      allowOfficialBrandName: Number(selfAccountType) === ACCOUNT_TYPE.OFFICIEL,
    });
    if (!nameGuard.ok) {
      return res.status(400).json({ error: nameGuard.message, code: nameGuard.code });
    }

    if (bio !== undefined) {
      const trimmedBio = typeof bio === 'string' ? bio.trim() : '';
      if (trimmedBio.length > 500) {
        return res.status(400).json({ error: 'La bio ne peut pas dépasser 500 caractères' });
      }
      updates.push('bio = ?');
      values.push(trimmedBio === '' ? null : trimmedBio);
    }
    if (avatar_url){ updates.push('avatar_url = ?'); values.push(avatar_url); }
    if (fcm_token) { updates.push('fcm_token = ?');  values.push(fcm_token); }
    if (device_ID) { updates.push('device_ID = ?');  values.push(device_ID); }
    if (idPays != null) {
      if (!(await countryExists(idPays))) {
        return res.status(400).json({ error: 'Pays invalide' });
      }
      updates.push('idPays = ?');
      values.push(Number(idPays));
      updates.push('idVille = NULL');
    }
    // Genre et âge sont à ÉCRITURE UNIQUE : une fois renseignés, ils ne sont plus
    // modifiables par l'utilisateur. Ce sont des données déclaratives sur
    // lesquelles on veut pouvoir s'appuyer ; les laisser changer librement en
    // ferait des champs de profil ordinaires, sans valeur analytique.
    // La lecture ci-dessous sert à renvoyer une erreur explicite ; c'est le
    // COALESCE des UPDATE qui garantit la règle, y compris si deux requêtes
    // arrivent en même temps (la seconde n'écrase alors rien).
    const veutEcrireGenre = genre !== undefined && genre !== null && genre !== '';
    const veutEcrireAge = age !== undefined && age !== null && age !== '';

    if (veutEcrireGenre || veutEcrireAge) {
      const [actuels] = await pool.execute(
        'SELECT genre, age FROM users WHERE alanyaID = ?',
        [req.user.alanyaID],
      );
      const actuel = actuels[0] || {};

      if (veutEcrireGenre) {
        if (!GENRES.includes(genre)) {
          return res.status(400).json({ error: `Genre invalide (attendu : ${GENRES.join(', ')})` });
        }
        if (actuel.genre != null) {
          return res.status(409).json({
            error: 'Le genre ne peut pas être modifié',
            code: 'FIELD_IMMUTABLE',
          });
        }
        updates.push('genre = COALESCE(genre, ?)');
        values.push(genre);
      }

      if (veutEcrireAge) {
        const ageNum = Number(age);
        if (!Number.isInteger(ageNum) || ageNum < AGE_MIN || ageNum > AGE_MAX) {
          return res.status(400).json({ error: `Âge invalide (entre ${AGE_MIN} et ${AGE_MAX})` });
        }
        if (actuel.age != null) {
          return res.status(409).json({
            error: 'L\'âge ne peut pas être modifié',
            code: 'FIELD_IMMUTABLE',
          });
        }
        // L'année de naissance est DÉDUITE ici et nulle part ailleurs : le client
        // ne l'envoie jamais. Elle est approximative (l'anniversaire de l'année en
        // cours peut être passé ou non), mais contrairement à l'âge elle ne se
        // périme pas. C'est elle qui permettra plus tard de recalculer l'âge de
        // tout le monde une fois par an, sans rien redemander aux utilisateurs :
        //   UPDATE users SET age = YEAR(NOW()) - annee_naissance
        //   WHERE annee_naissance IS NOT NULL;
        updates.push('age = COALESCE(age, ?), annee_naissance = COALESCE(annee_naissance, ?)');
        values.push(ageNum, new Date().getFullYear() - ageNum);
      }
    }
    // is_online/last_seen vivent dans user_presence, pas `users` (audit
    // scalabilité, fractionnement par colonnes) — traité à part du builder
    // dynamique ci-dessus, qui ne les alimente plus.
    if (is_online !== undefined) {
      await pool.execute(
        `INSERT INTO user_presence (alanyaID, is_online, last_seen) VALUES (?, ?, NOW())
         ON DUPLICATE KEY UPDATE is_online = VALUES(is_online), last_seen = VALUES(last_seen)`,
        [req.user.alanyaID, is_online ? 1 : 0],
      );
    }

    if (updates.length === 0 && is_online === undefined) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    if (updates.length > 0) {
      values.push(req.user.alanyaID);
      await pool.execute(
        `UPDATE users SET ${updates.join(', ')} WHERE alanyaID = ?`,
        values
      );
    }

    const [rows] = await pool.execute(_selectUserWithPays, [req.user.alanyaID]);

    res.json(rows[0]);
  } catch (error) {
    console.error('[UpdateMe] ERROR:', error);
    res.status(500).json({ error: error.message });
  }
};

// Demande d'OTP pour ajouter / remplacer l'email du compte connecté
const requestEmailChangeOtp = async (req, res) => {
  try {
    const cleanEmail = normalizeEmail(req.body.email);
    if (!cleanEmail) {
      return res.status(400).json({ error: 'Email requis' });
    }
    if (!EMAIL_REGEX.test(cleanEmail)) {
      return res.status(400).json({ error: 'Email invalide' });
    }

    const [meRows] = await pool.execute(
      'SELECT email FROM users WHERE alanyaID = ? AND exclus = 0',
      [req.user.alanyaID]
    );
    if (meRows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    const current = meRows[0].email ? String(meRows[0].email).toLowerCase() : null;
    if (current && current === cleanEmail) {
      return res.status(400).json({ error: 'Cet email est déjà associé à votre compte' });
    }

    const [taken] = await pool.execute(
      'SELECT alanyaID FROM users WHERE email = ? AND alanyaID != ?',
      [cleanEmail, req.user.alanyaID]
    );
    if (taken.length > 0) {
      return res.status(409).json({ error: 'Cette adresse Email est déjà utilisée' });
    }

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.execute(
      `UPDATE users
       SET pending_email = ?, email_change_otp = ?, email_change_otp_expires_at = ?
       WHERE alanyaID = ?`,
      [cleanEmail, otp, expiresAt, req.user.alanyaID]
    );

    await sendEmailChangeOTP(cleanEmail, otp);

    res.json({ message: 'Vérifiez votre email pour le code de confirmation' });
  } catch (error) {
    console.error('[RequestEmailChangeOtp] ERROR:', error);
    res.status(500).json({ error: error.message || 'Request failed' });
  }
};

// Confirme l'OTP et applique le nouvel email
const confirmEmailChange = async (req, res) => {
  try {
    const cleanEmail = normalizeEmail(req.body.email);
    const otp = req.body.otp != null ? String(req.body.otp).trim() : '';

    if (!cleanEmail || !otp) {
      return res.status(400).json({ error: 'Email et OTP requis' });
    }

    const [rows] = await pool.execute(
      `SELECT pending_email, email_change_otp, email_change_otp_expires_at
       FROM users WHERE alanyaID = ? AND exclus = 0`,
      [req.user.alanyaID]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    const user = rows[0];
    if (!user.pending_email || !user.email_change_otp) {
      return res.status(400).json({ error: 'Aucune demande de changement d\'email en cours' });
    }

    if (String(user.pending_email).toLowerCase() !== cleanEmail) {
      return res.status(400).json({ error: 'Email ne correspond pas à la demande en cours' });
    }

    if (user.email_change_otp !== otp) {
      return res.status(401).json({ error: 'OTP invalide' });
    }

    if (new Date() > new Date(user.email_change_otp_expires_at)) {
      return res.status(401).json({ error: 'OTP expiré' });
    }

    // Re-vérifier l'unicité au moment de la confirmation
    const [taken] = await pool.execute(
      'SELECT alanyaID FROM users WHERE email = ? AND alanyaID != ?',
      [cleanEmail, req.user.alanyaID]
    );
    if (taken.length > 0) {
      return res.status(409).json({ error: 'Cette adresse Email est déjà utilisée' });
    }

    await pool.execute(
      `UPDATE users
       SET email = ?,
           pending_email = NULL,
           email_change_otp = NULL,
           email_change_otp_expires_at = NULL
       WHERE alanyaID = ?`,
      [cleanEmail, req.user.alanyaID]
    );

    const [updated] = await pool.execute(_selectUserWithPays, [req.user.alanyaID]);
    res.json({ message: 'Email mis à jour', user: updated[0] });
  } catch (error) {
    console.error('[ConfirmEmailChange] ERROR:', error);
    res.status(500).json({ error: error.message || 'Confirmation failed' });
  }
};

// Changement de mot de passe authentifié (mot de passe actuel requis)
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        error: 'Mot de passe actuel et nouveau mot de passe requis',
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        error: 'Le nouveau mot de passe doit contenir au moins 6 caractères',
      });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({
        error: 'Le nouveau mot de passe doit être différent de l\'actuel',
      });
    }

    const [rows] = await pool.execute(
      'SELECT password FROM users WHERE alanyaID = ? AND exclus = 0',
      [req.user.alanyaID]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    const valid = await bcrypt.compare(currentPassword, rows[0].password);
    if (!valid) {
      return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
    }

    const hashed = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await pool.execute(
      'UPDATE users SET password = ? WHERE alanyaID = ?',
      [hashed, req.user.alanyaID]
    );

    res.json({ message: 'Mot de passe modifié avec succès' });
  } catch (error) {
    console.error('[ChangePassword] ERROR:', error);
    res.status(500).json({ error: error.message || 'Échec du changement de mot de passe' });
  }
};

// ── Code de récupération ────────────────────────────────────────────────────
//
// Noter ce qui n'est PAS fait ici : ni changePassword ni completePasswordReset ne
// touchent recovery_code_enc. Le code survit donc à tout changement de mot de
// passe — c'est l'exigence, et c'est aussi ce qui le rend notable une fois pour
// toutes sur un bout de papier.

/**
 * Voie de récupération sans e-mail : numéro Alanya + code ⇒ même resetToken que
 * validateOTP, donc `POST /auth/reset-password-confirm` fonctionne tel quel
 * derrière. Écrire un second chemin de changement de mot de passe aurait été
 * l'occasion d'oublier une garde.
 */
const validateRecoveryCode = async (req, res) => {
  try {
    const { alanyaPhone, recoveryCode: saisie } = req.body;

    if (!alanyaPhone || !saisie) {
      return res.status(400).json({ error: 'Numéro Alanya et code de récupération requis' });
    }

    // Réponse volontairement identique pour « numéro inconnu », « aucun code » et
    // « code faux » : distinguer ces cas dirait à un attaquant quels numéros
    // existent, alors que le numéro Alanya est justement l'identifiant public.
    const echec = () =>
      res.status(401).json({ error: 'Numéro ou code de récupération invalide' });

    const [rows] = await pool.execute(
      `SELECT alanyaID, recovery_code_enc, exclus, exclude_reason, delete_scheduled_at
       FROM users WHERE alanyaPhone = ?`,
      [normalize(alanyaPhone)],
    );
    if (rows.length === 0) return echec();

    const user = rows[0];

    // Mêmes gardes que login : un compte banni ou en cours de suppression ne doit
    // pas pouvoir être réactivé par un changement de mot de passe.
    if (user.exclus === 1) {
      if (
        user.exclude_reason === 'self_delete_pending'
        && user.delete_scheduled_at
        && new Date(user.delete_scheduled_at).getTime() > Date.now()
      ) {
        return res.status(403).json({
          error: 'Suppression du compte en cours',
          code: 'ACCOUNT_DELETION_PENDING',
          scheduledAt: user.delete_scheduled_at,
        });
      }
      return res.status(403).json({ error: 'Compte banni' });
    }

    if (!recoveryCode.matches(user.recovery_code_enc, saisie)) return echec();

    const resetToken = jwt.sign(
      { alanyaID: user.alanyaID, type: 'password_reset' },
      process.env.JWT_SECRET || 'talky-secret-key-change-in-production',
      { expiresIn: '15m' },
    );

    res.json({ resetToken, message: 'Code validé. Utilisez resetToken pour changer le mot de passe' });
  } catch (error) {
    console.error('[ValidateRecoveryCode] ERROR:', error);
    res.status(500).json({ error: error.message || 'Validation échouée' });
  }
};

/**
 * Reconsultation du code par son propriétaire, derrière le mot de passe : un
 * appareil déverrouillé et laissé sans surveillance ne doit pas suffire à
 * repartir avec la clé de secours du compte.
 */
const revealRecoveryCode = async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ error: 'Mot de passe requis' });
    }

    const [rows] = await pool.execute(
      'SELECT password, recovery_code_enc FROM users WHERE alanyaID = ? AND exclus = 0',
      [req.user.alanyaID],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    const valid = await bcrypt.compare(password, rows[0].password);
    if (!valid) {
      return res.status(401).json({ error: 'Mot de passe incorrect' });
    }

    let code = recoveryCode.decrypt(rows[0].recovery_code_enc);

    // Comptes antérieurs à la migration 037, ou code devenu illisible après une
    // rotation de clé : on en émet un à la volée plutôt que de laisser un compte
    // sans voie de récupération. Évite aussi un script de backfill.
    if (!code) {
      const emis = recoveryCode.issue();
      await pool.execute(
        'UPDATE users SET recovery_code_enc = ? WHERE alanyaID = ?',
        [emis.encrypted, req.user.alanyaID],
      );
      code = emis.code;
    }

    res.json({ recoveryCode: recoveryCode.format(code) });
  } catch (error) {
    console.error('[RevealRecoveryCode] ERROR:', error);
    res.status(500).json({ error: error.message || 'Lecture du code échouée' });
  }
};

module.exports = {
  register,
  login,
  refreshToken,
  resetPassword,
  requestPasswordReset,
  validateOTP,
  completePasswordReset,
  getMe,
  updateMe,
  updateFcmToken,
  requestEmailChangeOtp,
  confirmEmailChange,
  changePassword,
  validateRecoveryCode,
  revealRecoveryCode,
  authCustom: require('../middleware/authCustom').authCustom,
};
