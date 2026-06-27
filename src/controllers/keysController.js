const crypto = require('crypto');
const pool = require('../config/db');

// Le serveur est zero-knowledge : tout ce qui transite ici est une clé
// PUBLIQUE (ou un sel non secret). Aucune clé privée ne doit jamais
// atteindre ces endpoints.

// Dépose le prekey bundle (identity + signed prekey) et un lot de one-time
// prekeys, toutes en clé publique (encodées base64 côté client).
const uploadKeys = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const {
      identityKeyDh,
      identityKeySign,
      signedPrekey,
      registrationId,
      oneTimePreKeys,
    } = req.body;

    if (!identityKeyDh || !identityKeySign || !signedPrekey?.keyId || !signedPrekey?.publicKey || !signedPrekey?.signature) {
      return res.status(400).json({
        error: 'identityKeyDh, identityKeySign et signedPrekey {keyId, publicKey, signature} sont requis',
      });
    }

    await pool.execute(
      `INSERT INTO prekey_bundles
         (alanyaID, identity_key_dh, identity_key_sign, signed_prekey, signed_prekey_id, signature, registration_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         identity_key_dh   = VALUES(identity_key_dh),
         identity_key_sign = VALUES(identity_key_sign),
         signed_prekey     = VALUES(signed_prekey),
         signed_prekey_id  = VALUES(signed_prekey_id),
         signature         = VALUES(signature),
         registration_id   = VALUES(registration_id)`,
      [
        alanyaID,
        Buffer.from(identityKeyDh, 'base64'),
        Buffer.from(identityKeySign, 'base64'),
        Buffer.from(signedPrekey.publicKey, 'base64'),
        signedPrekey.keyId,
        Buffer.from(signedPrekey.signature, 'base64'),
        registrationId ?? null,
      ]
    );

    if (Array.isArray(oneTimePreKeys) && oneTimePreKeys.length > 0) {
      const values = [];
      const placeholders = oneTimePreKeys.map(({ keyId, publicKey }) => {
        values.push(alanyaID, keyId, Buffer.from(publicKey, 'base64'));
        return '(?, ?, ?)';
      });

      await pool.query(
        `INSERT IGNORE INTO one_time_prekeys (alanyaID, key_id, public_key)
         VALUES ${placeholders.join(', ')}`,
        values
      );
    }

    // Bootstrap du vault_salt pour les comptes créés avant l'introduction de
    // l'E2EE (la migration 009 a ajouté la colonne sans backfill).
    const [userRows] = await pool.execute(
      'SELECT vault_salt FROM users WHERE alanyaID = ?',
      [alanyaID]
    );
    let vaultSalt = userRows[0]?.vault_salt;
    if (!vaultSalt) {
      vaultSalt = crypto.randomBytes(16);
      await pool.execute('UPDATE users SET vault_salt = ? WHERE alanyaID = ?', [vaultSalt, alanyaID]);
    }

    res.status(201).json({
      ok: true,
      vaultSalt: vaultSalt.toString('base64'),
    });
  } catch (error) {
    console.error('[UploadKeys] ERROR:', error.message);
    res.status(500).json({ error: error.message || 'Échec du dépôt des clés' });
  }
};

// Renvoie le bundle public d'un utilisateur + une one-time prekey consommée
// atomiquement, pour permettre à l'appelant de faire un X3DH hors-ligne.
const getBundle = async (req, res) => {
  const { alanyaID } = req.params;
  const conn = await pool.getConnection();
  try {
    const [bundleRows] = await conn.execute(
      'SELECT alanyaID, identity_key_dh, identity_key_sign, signed_prekey, signed_prekey_id, signature FROM prekey_bundles WHERE alanyaID = ?',
      [alanyaID]
    );

    if (bundleRows.length === 0) {
      return res.status(404).json({ error: 'Aucun bundle de clés pour cet utilisateur' });
    }

    const bundle = bundleRows[0];

    await conn.beginTransaction();
    const [otpRows] = await conn.execute(
      `SELECT id, key_id, public_key FROM one_time_prekeys
       WHERE alanyaID = ? AND used = 0
       ORDER BY id LIMIT 1
       FOR UPDATE`,
      [alanyaID]
    );

    let prekey = null;
    if (otpRows.length > 0) {
      const otp = otpRows[0];
      await conn.execute('UPDATE one_time_prekeys SET used = 1 WHERE id = ?', [otp.id]);
      prekey = {
        keyId: otp.key_id,
        publicKey: otp.public_key.toString('base64'),
      };
    }
    await conn.commit();

    res.json({
      identityKeyDh: bundle.identity_key_dh.toString('base64'),
      identityKeySign: bundle.identity_key_sign.toString('base64'),
      signedPrekey: {
        keyId: bundle.signed_prekey_id,
        publicKey: bundle.signed_prekey.toString('base64'),
        signature: bundle.signature.toString('base64'),
      },
      prekey,
    });
  } catch (error) {
    await conn.rollback();
    console.error('[GetBundle] ERROR:', error.message);
    res.status(500).json({ error: error.message || 'Échec de la récupération du bundle' });
  } finally {
    conn.release();
  }
};

// Nombre de one-time prekeys restantes pour l'utilisateur connecté, afin
// que le client sache quand re-uploader un lot.
const getKeyCount = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT COUNT(*) AS count FROM one_time_prekeys WHERE alanyaID = ? AND used = 0',
      [req.user.alanyaID]
    );
    res.json({ count: rows[0].count });
  } catch (error) {
    console.error('[GetKeyCount] ERROR:', error.message);
    res.status(500).json({ error: error.message || 'Échec du comptage des clés' });
  }
};

// Renvoie (en le générant si besoin) le vault_salt de l'utilisateur connecté.
const getVaultSalt = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT vault_salt FROM users WHERE alanyaID = ?',
      [req.user.alanyaID]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    let vaultSalt = rows[0].vault_salt;
    if (!vaultSalt) {
      vaultSalt = crypto.randomBytes(16);
      await pool.execute('UPDATE users SET vault_salt = ? WHERE alanyaID = ?', [vaultSalt, req.user.alanyaID]);
    }

    res.json({ vaultSalt: vaultSalt.toString('base64') });
  } catch (error) {
    console.error('[GetVaultSalt] ERROR:', error.message);
    res.status(500).json({ error: error.message || 'Échec de la récupération du vault_salt' });
  }
};

module.exports = {
  uploadKeys,
  getBundle,
  getKeyCount,
  getVaultSalt,
};
