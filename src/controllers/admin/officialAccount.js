const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../../config/db');
const { ACCOUNT_TYPE, resolveOfficialAvatarUrl } = require('../../constants/accountTypes');
const { guardDisplayNames } = require('../../utils/displayNameGuard');
const { invalidateOfficialAccountCache } = require('../../utils/officialAccountGuard');

const SALT_ROUNDS = 10;

/**
 * Identité imposée. Aucun de ces champs n'est saisi par l'administrateur : le
 * compte officiel n'est pas une personne, c'est la voix de l'application.
 *
 * Le numéro `000` est semé comme réservé par la migration 010. Sa longueur — 3
 * chiffres — est ce qui rend ce compte possible sans identité personnelle :
 * c'est le seul palier qui dispense d'une adresse e-mail.
 */
const OFFICIAL_IDENTITY = Object.freeze({
  nom: 'Alanya',
  pseudo: 'alanya',
  alanyaPhone: '000',
  idPays: 10,
});

const SELECT_OFFICIAL = `
  SELECT u.alanyaID, u.nom, u.pseudo, u.alanyaPhone, u.email, u.avatar_url,
         u.type_compte, u.account_type, u.verification_status,
         u.is_online, u.last_seen, u.created_at, u.idPays,
         p.libelle AS pays_libelle
  FROM users u
  LEFT JOIN pays p ON u.idPays = p.idPays
  WHERE u.account_type = ?
  ORDER BY u.alanyaID ASC
  LIMIT 1`;

/**
 * @param {import('mysql2/promise').Pool|import('mysql2/promise').PoolConnection} db
 * @returns {Promise<object|null>}
 */
const findOfficialAccount = async (db = pool) => {
  const [rows] = await db.execute(SELECT_OFFICIAL, [ACCOUNT_TYPE.OFFICIEL]);
  return rows[0] || null;
};

// ── GET /api/admin/official-account ──────────────────────────────────
// Renvoie le compte ou null. Le formulaire de création et le composeur de
// diffusion s'en servent pour leurs états vides : sans lui, l'un proposerait
// de créer un doublon et l'autre laisserait composer sans expéditeur.
const getOfficialAccount = async (req, res) => {
  try {
    res.json(await findOfficialAccount());
  } catch (e) {
    console.error('[Admin] getOfficialAccount:', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// ── POST /api/admin/official-account ─────────────────────────────────
// Corps vide : tout est dérivé. Super-admin, comme les autres actes
// irréversibles sur les comptes.
const createOfficialAccount = async (req, res) => {
  let conn = null;
  let locked = false;
  try {
    conn = await pool.getConnection();

    // GET_LOCK est porté par la connexion : deux appels simultanés ne peuvent
    // pas passer le contrôle d'unicité en même temps. Même patron que
    // publishBroadcast.
    const [[lock]] = await conn.execute("SELECT GET_LOCK('official_account_create', 10) AS l");
    if (!lock.l) {
      return res.status(409).json({ error: 'Création déjà en cours', code: 'OFFICIAL_BUSY' });
    }
    locked = true;

    const existing = await findOfficialAccount(conn);
    if (existing) {
      return res.status(409).json({
        error: 'Un compte officiel existe déjà',
        code: 'OFFICIAL_ALREADY_EXISTS',
        alanyaID: existing.alanyaID,
      });
    }

    // Le seul compte autorisé à porter « Alanya » — le garde refuse ce nom
    // partout ailleurs, homoglyphes cyrilliques compris.
    const nameGuard = guardDisplayNames({
      nom: OFFICIAL_IDENTITY.nom,
      pseudo: OFFICIAL_IDENTITY.pseudo,
      accountType: ACCOUNT_TYPE.OFFICIEL,
      allowOfficialBrandName: true,
    });
    if (!nameGuard.ok) {
      return res.status(500).json({ error: nameGuard.message, code: nameGuard.code });
    }

    const [phoneTaken] = await conn.execute(
      'SELECT alanyaID FROM users WHERE alanyaPhone = ?',
      [OFFICIAL_IDENTITY.alanyaPhone],
    );
    if (phoneTaken.length) {
      return res.status(409).json({
        error: `Le numéro ${OFFICIAL_IDENTITY.alanyaPhone} est déjà attribué`,
        code: 'OFFICIAL_PHONE_TAKEN',
      });
    }

    const avatarUrl = resolveOfficialAvatarUrl();
    if (!avatarUrl) {
      return res.status(500).json({
        error: 'Aucun logo configuré : renseignez LOGO_URL ou OFFICIAL_ACCOUNT_AVATAR_URL',
        code: 'OFFICIAL_AVATAR_MISSING',
      });
    }

    // Mot de passe aléatoire jamais restitué, e-mail nul, code de récupération
    // nul : les trois seules voies de connexion sont fermées par construction.
    // Un compte que personne ne peut ouvrir ne peut pas être détourné.
    const password = await bcrypt.hash(crypto.randomBytes(64).toString('hex'), SALT_ROUNDS);

    const [result] = await conn.execute(
      `INSERT INTO users
        (nom, pseudo, alanyaPhone, email, password, idPays, avatar_url,
         type_compte, account_type, verification_status, recovery_code_enc,
         fcm_token, device_ID, last_seen, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 0, ?, 0, NULL, 'INDEFINI', 'INDEFINI', NOW(), NOW())`,
      [
        OFFICIAL_IDENTITY.nom,
        OFFICIAL_IDENTITY.pseudo,
        OFFICIAL_IDENTITY.alanyaPhone,
        password,
        OFFICIAL_IDENTITY.idPays,
        avatarUrl,
        ACCOUNT_TYPE.OFFICIEL,
      ],
    );

    const [rows] = await conn.execute(
      SELECT_OFFICIAL.replace('WHERE u.account_type = ?', 'WHERE u.alanyaID = ?'),
      [result.insertId],
    );

    // Les gardes (appel, ajout, blocage, connexion) lisent un identifiant mis en
    // cache : sans cette invalidation, ils laisseraient passer pendant une
    // minute un compte qui vient pourtant d'exister.
    invalidateOfficialAccountCache();

    console.log(`[Admin] Compte officiel créé (alanyaID=${result.insertId}) par ${req.user.alanyaID}`);
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('[Admin] createOfficialAccount:', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    if (conn) {
      if (locked) {
        try { await conn.execute("SELECT RELEASE_LOCK('official_account_create')"); } catch (_) {}
      }
      conn.release();
    }
  }
};

module.exports = {
  OFFICIAL_IDENTITY,
  findOfficialAccount,
  getOfficialAccount,
  createOfficialAccount,
};
