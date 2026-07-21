const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { sendMail, renderHtmlEmail, escapeHtml } = require('../services/mailService');
const { generateAccessToken, generateRefreshToken, JWT_REFRESH_SECRET } = require('../middleware/authCustom');
const { normalize } = require('../utils/alanyaPhone');
const { generateUniquePhone } = require('../services/alanyaPhoneService');

const SALT_ROUNDS = 10;

const _selectUserWithPays = `
  SELECT u.alanyaID, u.nom, u.pseudo, u.alanyaPhone, u.email, u.idPays,
         u.avatar_url, u.type_compte, u.is_online, u.last_seen,
         p.libelle AS pays_libelle, p.prefix AS pays_prefix
  FROM users u
  LEFT JOIN pays p ON u.idPays = p.idPays
  WHERE u.alanyaID = ?
`;

const countryExists = async (idPays) => {
  const id = Number(idPays);
  if (!Number.isFinite(id) || id <= 0) return false;
  const [rows] = await pool.execute('SELECT idPays FROM pays WHERE idPays = ?', [id]);
  return rows.length > 0;
};

// Journalise une connexion (login, inscription, refresh) dans userAccess.
// Best-effort : ne fait jamais échouer la requête appelante.
// `device` doit être un libellé lisible (marque + modèle, ex. "Samsung SM-A715F").
const logUserAccess = async (req, alanyaID, { device, osSystem } = {}) => {
  try {
    const ipAdress =
      req.ip ||
      req.headers['x-forwarded-for'] ||
      req.connection?.remoteAddress ||
      'INDEFINI';
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

// Création de compte 
const register = async (req, res) => {
  try {
    const { email, password, nom, pseudo, idPays, fcm_token, device_ID, device_model, os_system } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit faire au moins 6 caractères' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Email invalide' });
    }

    const [existingEmail] = await pool.execute(
      'SELECT alanyaID FROM users WHERE email = ?',
      [email.toLowerCase().trim()]
    );
    if (existingEmail.length > 0) {
      return res.status(409).json({ error: 'Cette adresse Email est déjà utilisée' });
    }

    const alanyaPhone = await generateAlanyaPhone();
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    const resolvedIdPays = idPays != null ? Number(idPays) : 10;
    if (!(await countryExists(resolvedIdPays))) {
      return res.status(400).json({ error: 'Pays invalide' });
    }

    const [result] = await pool.execute(
      `INSERT INTO users
        (nom, pseudo, alanyaPhone, email, password, idPays, avatar_url,
         fcm_token, device_ID, last_seen, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        nom        || 'Utilisateur',
        pseudo     || nom || 'AlanyaUser',
        alanyaPhone,
        email.toLowerCase().trim(),
        hashedPassword,
        resolvedIdPays,
        'NON DEFINI',
        fcm_token  || 'INDEFINI',
        device_ID  || 'INDEFINI',
      ]
    );

    const tokenPayload  = { alanyaID: result.insertId, email: email.toLowerCase().trim() };
    const accessToken   = generateAccessToken(tokenPayload);
    const refreshToken  = generateRefreshToken(tokenPayload);

    const [rows] = await pool.execute(
      'SELECT alanyaID, nom, pseudo, alanyaPhone, email, avatar_url, is_online, last_seen FROM users WHERE alanyaID = ?',
      [result.insertId]
    );

    // Journalise l'inscription comme premier "login" dans userAccess.
    logUserAccess(req, result.insertId, {
      device: device_model || device_ID,
      osSystem: os_system,
    });

    res.status(201).json({ user: rows[0], accessToken, refreshToken });
  } catch (error) {
    console.error('[Register] ERROR:', error);
    res.status(500).json({ error: error.message || 'Registration failed' });
  }
};

// Connexion
const login = async (req, res) => {
  try {
    const { alanyaPhone, password, fcm_token, device_ID, device_model, os_system } = req.body;

    if (!alanyaPhone || !password) {
      return res.status(400).json({ error: 'Alanya phone et mot de passe requis' });
    }

    const phoneCanonical = normalize(alanyaPhone);

    const [rows] = await pool.execute(
      'SELECT alanyaID, nom, pseudo, alanyaPhone, email, password, avatar_url, is_online, exclus FROM users WHERE alanyaPhone = ?',
      [phoneCanonical]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    const user = rows[0];

    if (user.exclus === 1) {
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

    const tokenPayload = { alanyaID: user.alanyaID, email: user.email };
    const accessToken  = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    delete user.password;
    delete user.exclus;

    // Journalise la connexion dans userAccess (best-effort).
    logUserAccess(req, user.alanyaID, {
      device: device_model || device_ID,
      osSystem: os_system,
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

    const tokenPayload    = { alanyaID: rows[0].alanyaID, email: rows[0].email };
    const newAccessToken  = generateAccessToken(tokenPayload);
    const newRefreshToken = generateRefreshToken(tokenPayload);

    res.json({ accessToken: newAccessToken, refreshToken: newRefreshToken });
  } catch (error) {
    console.error('[RefreshToken] ERROR:', error);
    res.status(500).json({ error: 'Echec du refresh du token' });
  }
};

// Génération d'un OTP à 6 chiffres (mot de passe oublié)
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Envoi de l'OTP par email pour la réinitialisation du mot de passe
const sendPasswordResetOTP = async (email, otp) => {
  const fromEmail =process.env.SMTP_FROM ;
  const fromName = process.env.MAIL_FROM_NAME || 'Alanya';
  const appName = process.env.APP_NAME || 'Alanya';
  const supportEmail = process.env.SUPPORT_EMAIL || process.env.SMTP_FROM || 'support@example.com';
  const expiryMin = Number(process.env.OTP_EXPIRY_MIN || 10);

  const subject = `Réinitialisation de votre mot de passe ${appName}`;

  const text = `Bonjour,\n\n` +
    `Nous avons reçu une demande de réinitialisation du mot de passe pour le compte associé à ${email}.\n\n` +
    `Votre code de réinitialisation : ${otp}\n` +
    `Ce code est valable pendant ${expiryMin} minutes.\n\n` +
    `Si vous n'êtes pas à l'origine de cette demande, ignorez ce message ou contactez le support : ${supportEmail}.\n\n` +
    `Ne partagez jamais ce code avec qui que ce soit.\n\n` +
    `Cordialement,\nL'équipe ${appName}`;

  const html = renderHtmlEmail({
    title: subject,
    preheader: `Votre code de réinitialisation est ${otp}`,
    eyebrow: appName,
    heading: 'Réinitialisation de votre mot de passe',
    intro: `Nous avons reçu une demande de réinitialisation du mot de passe pour le compte lié à ${escapeHtml(email)}.`,
    bodyHtml: `
      <p style="text-align:center;margin:8px 0 22px 0;">
        <span class="code">${escapeHtml(otp)}</span>
      </p>
      <p style="margin-top:0;">Ce code expire dans ${expiryMin} minutes.</p>
      <p>Si vous n'avez pas demandé cette réinitialisation, ignorez ce courriel ou contactez-nous à <a href="mailto:${escapeHtml(supportEmail)}" style="color:#1f2937;font-weight:700;">${escapeHtml(supportEmail)}</a>.</p>
      <p>Ne partagez jamais ce code avec qui que ce soit.</p>`,
    accent: '#1f2937',
    footerNote: 'Si vous n\'êtes pas à l\'origine de cette demande, ignorez ce message ou contactez le support.',
    supportEmail,
  });

  if (!fromEmail) {
    throw new Error("L'adresse email d\'envoi est requise (SMTP_FROM dans .env)");
  }

  if (!process.env.SMTP_HOST) {
    throw new Error("Le service email n'est pas configuré");
  }
  // Delegate to mailService
  await sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to: email,
    subject,
    text,
    html,
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
  try {
    const { email, newPassword } = req.body;

    if (!email || !newPassword) {
      return res.status(400).json({ error: 'Email et nouveau mot de passe requis' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });
    }

    const [rows] = await pool.execute(
      'SELECT alanyaID FROM users WHERE email = ?',
      [email.toLowerCase().trim()]
    );

    if (rows.length === 0) { 
      return res.json({ message: 'Si cet email existe, le mot de passe a été réinitialisé' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await pool.execute(
      'UPDATE users SET password = ? WHERE alanyaID = ?',
      [hashedPassword, rows[0].alanyaID]
    );

    res.json({ message: 'Mot de passe mis à jour avec succès' });
  } catch (error) {
    console.error('[ResetPassword] ERROR:', error);
    res.status(500).json({ error: error.message || 'Échec de la réinitialisation du mot de passe' });
  }
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

// Met à jour les infos de l'utilisateur (nom, pseudo, avatar_url, fcm_token, device_ID, is_online)
const updateMe = async (req, res) => {
  try {
    const { nom, pseudo, avatar_url, fcm_token, device_ID, is_online, idPays } = req.body;
    const updates = [];
    const values  = [];

    if (nom)       { updates.push('nom = ?');        values.push(nom); }
    if (pseudo)    { updates.push('pseudo = ?');     values.push(pseudo); }
    if (avatar_url){ updates.push('avatar_url = ?'); values.push(avatar_url); }
    if (fcm_token) { updates.push('fcm_token = ?');  values.push(fcm_token); }
    if (device_ID) { updates.push('device_ID = ?');  values.push(device_ID); }
    if (idPays != null) {
      if (!(await countryExists(idPays))) {
        return res.status(400).json({ error: 'Pays invalide' });
      }
      updates.push('idPays = ?');
      values.push(Number(idPays));
    }
    if (is_online !== undefined) {
      updates.push('is_online = ?, last_seen = NOW()');
      values.push(is_online ? 1 : 0);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.user.alanyaID);
    await pool.execute(
      `UPDATE users SET ${updates.join(', ')} WHERE alanyaID = ?`,
      values
    );

    const [rows] = await pool.execute(_selectUserWithPays, [req.user.alanyaID]);

    res.json(rows[0]);
  } catch (error) {
    console.error('[UpdateMe] ERROR:', error);
    res.status(500).json({ error: error.message });
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
  authCustom: require('../middleware/authCustom').authCustom,
};
