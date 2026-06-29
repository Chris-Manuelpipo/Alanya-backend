const bcrypt = require('bcryptjs');
const pool = require('../../config/db');
const {
  normalize,
  validate,
  formatDisplay,
} = require('../../utils/alanyaPhone');
const {
  isReserved,
  isPhoneAvailable,
  generateUniquePhone,
  phoneExists,
} = require('../../services/alanyaPhoneService');
const { sendMail, renderHtmlEmail, escapeHtml } = require('../../services/mailService');
const { sendToUser } = require('../../services/notificationService');
const { _buildUserMailFrom, _appName } = require('./helpers');

const SALT_ROUNDS = 10;

const countryExists = async (idPays) => {
  const id = Number(idPays);
  if (!Number.isFinite(id) || id <= 0) return false;
  const [rows] = await pool.execute('SELECT idPays FROM pays WHERE idPays = ?', [id]);
  return rows.length > 0;
};

const _defaultAvatar = (gender) => {
  if (gender === 'female') {
    return process.env.AVATAR_DEFAULT_FEMALE || 'NON DEFINI';
  }
  return process.env.AVATAR_DEFAULT_MALE || 'NON DEFINI';
};

const _notifyCredentials = async ({ email, nom, alanyaPhone, password }) => {
  if (!email) return;
  const formatted = formatDisplay(alanyaPhone);
  const subject = `Vos identifiants ${_appName}`;
  const text =
    `Bonjour ${nom || 'utilisateur'},\n\n` +
    `Votre compte ${_appName} a été créé.\n\n` +
    `Téléphone Alanya : ${formatted}\n` +
    `Mot de passe : ${password}\n\n` +
    `Conservez ces informations en lieu sûr.\n`;
  const html = renderHtmlEmail({
    title: subject,
    preheader: `Téléphone Alanya : ${formatted}`,
    eyebrow: _appName,
    heading: 'Vos identifiants de connexion',
    intro: `Bonjour ${escapeHtml(nom || 'utilisateur')}, votre compte a été créé par un administrateur.`,
    bodyHtml: `
      <p><strong>Téléphone Alanya</strong><br><span style="font-size:22px;font-weight:700;letter-spacing:.12em">${escapeHtml(formatted)}</span></p>
      <p><strong>Mot de passe</strong><br><code>${escapeHtml(password)}</code></p>
      <p>Conservez ces informations en lieu sûr.</p>`,
    accent: '#1f2937',
  });
  await sendMail({
    from: _buildUserMailFrom(),
    to: email,
    subject,
    text,
    html,
  });
};

const _notifyPhoneChange = async ({ user, oldPhone, newPhone }) => {
  const oldFmt = formatDisplay(oldPhone);
  const newFmt = formatDisplay(newPhone);
  const title = 'Numéro Alanya modifié';

  if (user.email) {
    const subject = `${title} — ${_appName}`;
    const text =
      `Bonjour ${user.nom || 'utilisateur'},\n\n` +
      `Votre numéro Alanya a été modifié par un administrateur.\n\n` +
      `Ancien numéro : ${oldFmt}\n` +
      `Nouveau numéro : ${newFmt}\n`;
    const html = renderHtmlEmail({
      title: subject,
      preheader: `Nouveau numéro : ${newFmt}`,
      eyebrow: _appName,
      heading: title,
      bodyHtml: `
        <p>Bonjour ${escapeHtml(user.nom || 'utilisateur')},</p>
        <p>Votre numéro Alanya a été modifié.</p>
        <p>Ancien : <strong>${escapeHtml(oldFmt)}</strong><br>Nouveau : <strong>${escapeHtml(newFmt)}</strong></p>`,
      accent: '#1f2937',
    });
    await sendMail({
      from: _buildUserMailFrom(),
      to: user.email,
      subject,
      text,
      html,
    });
  }

  await sendToUser(user.alanyaID, {
    type: 'account',
    title,
    body: `Nouveau numéro : ${newFmt}`,
    event: 'phone_change',
    oldPhone,
    newPhone,
  });
};

const _resolvePhoneForCreate = async (req, body) => {
  const isSuper = (req.user.typeCompte ?? 0) >= 2;
  const manual = body.alanyaPhone != null && String(body.alanyaPhone).trim() !== '';

  if (manual) {
    const canonical = normalize(body.alanyaPhone);
    const v = validate(canonical);
    if (!v.ok) return { error: v.error, status: 400 };

    if (!isSuper) {
      if (v.tier !== 4) {
        return { error: 'Seuls les numéros à 4 chiffres peuvent être saisis manuellement', status: 403 };
      }
    }

    const reserved = await isReserved(canonical);
    if (reserved && !isSuper) {
      return { error: 'Ce numéro est réservé', status: 403 };
    }
    if (await phoneExists(canonical)) {
      return { error: 'Ce numéro est déjà utilisé', status: 409 };
    }

    return { canonical, tier: v.tier };
  }

  const genLen = Number(body.generateLength);
  if (![3, 4, 8].includes(genLen)) {
    return { error: 'generateLength doit être 3, 4 ou 8', status: 400 };
  }

  if (!isSuper && ![4, 8].includes(genLen)) {
    return { error: 'Génération 3 chiffres réservée au super-admin', status: 403 };
  }

  const canonical = await generateUniquePhone(genLen);
  return { canonical, tier: genLen };
};

const createUser = async (req, res) => {
  try {
    const {
      nom,
      pseudo,
      password,
      email,
      idPays,
      avatarGender,
      type_compte,
    } = req.body || {};

    if (!nom || !pseudo || !password) {
      return res.status(400).json({ error: 'nom, pseudo et password requis' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit faire au moins 6 caractères' });
    }

    const phoneResult = await _resolvePhoneForCreate(req, req.body);
    if (phoneResult.error) {
      return res.status(phoneResult.status).json({ error: phoneResult.error });
    }
    const { canonical, tier } = phoneResult;

    const isSuper = (req.user.typeCompte ?? 0) >= 2;
    let resolvedType = 0;
    if (isSuper && type_compte != null) {
      const t = Number(type_compte);
      if (![0, 1, 2].includes(t)) {
        return res.status(400).json({ error: 'type_compte doit être 0, 1 ou 2' });
      }
      resolvedType = t;
    }

    const trimmedEmail = email ? String(email).toLowerCase().trim() : null;
    if (tier !== 3 && !trimmedEmail) {
      return res.status(400).json({ error: 'Email requis pour ce type de compte' });
    }
    if (trimmedEmail) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(trimmedEmail)) {
        return res.status(400).json({ error: 'Email invalide' });
      }
      const [existingEmail] = await pool.execute(
        'SELECT alanyaID FROM users WHERE email = ?',
        [trimmedEmail]
      );
      if (existingEmail.length > 0) {
        return res.status(409).json({ error: 'Cette adresse email est déjà utilisée' });
      }
    }

    const resolvedIdPays = idPays != null ? Number(idPays) : 10;
    if (!(await countryExists(resolvedIdPays))) {
      return res.status(400).json({ error: 'Pays invalide' });
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const avatarUrl = _defaultAvatar(avatarGender === 'female' ? 'female' : 'male');

    const [result] = await pool.execute(
      `INSERT INTO users
        (nom, pseudo, alanyaPhone, email, password, idPays, avatar_url,
         type_compte, fcm_token, device_ID, last_seen, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'INDEFINI', 'INDEFINI', NOW(), NOW())`,
      [
        nom.trim(),
        pseudo.trim(),
        canonical,
        trimmedEmail,
        hashedPassword,
        resolvedIdPays,
        avatarUrl,
        resolvedType,
      ]
    );

    const [rows] = await pool.execute(
      `SELECT u.alanyaID, u.nom, u.pseudo, u.alanyaPhone, u.email, u.avatar_url,
              u.type_compte, u.is_online, u.last_seen, u.created_at, u.idPays,
              p.libelle AS pays_libelle
       FROM users u
       LEFT JOIN pays p ON u.idPays = p.idPays
       WHERE u.alanyaID = ?`,
      [result.insertId]
    );

    _notifyCredentials({
      email: trimmedEmail,
      nom: nom.trim(),
      alanyaPhone: canonical,
      password,
    }).catch((err) => console.error('[Admin] createUser mail error:', err.message));

    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('[Admin] createUser error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

const updateUserPhone = async (req, res) => {
  try {
    const { id } = req.params;
    const { alanyaPhone } = req.body || {};
    const canonical = normalize(alanyaPhone);
    const v = validate(canonical);
    if (!v.ok) {
      return res.status(400).json({ error: v.error });
    }

    const [users] = await pool.execute(
      'SELECT alanyaID, nom, email, alanyaPhone, fcm_token FROM users WHERE alanyaID = ?',
      [id]
    );
    if (users.length === 0) {
      return res.status(404).json({ error: 'Utilisateur introuvable' });
    }
    const user = users[0];
    if (user.alanyaPhone === canonical) {
      return res.json({ message: 'Numéro inchangé', alanyaPhone: canonical });
    }

    const reserved = await isReserved(canonical);
    if (reserved) {
      if (await phoneExists(canonical)) {
        return res.status(409).json({ error: 'Ce numéro est déjà utilisé' });
      }
    } else if (!(await isPhoneAvailable(canonical))) {
      return res.status(409).json({ error: 'Ce numéro est déjà utilisé' });
    }

    const oldPhone = user.alanyaPhone;
    await pool.execute(
      'UPDATE users SET alanyaPhone = ? WHERE alanyaID = ?',
      [canonical, id]
    );

    const updatedUser = { ...user, alanyaID: user.alanyaID };
    _notifyPhoneChange({ user: updatedUser, oldPhone, newPhone: canonical }).catch(
      (err) => console.error('[Admin] updateUserPhone notify error:', err.message)
    );

    res.json({ message: 'Numéro mis à jour', alanyaPhone: canonical });
  } catch (error) {
    console.error('[Admin] updateUserPhone error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = {
  createUser,
  updateUserPhone,
};
