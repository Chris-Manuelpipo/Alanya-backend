// Registre des appareils connectés (table `appareils`) — alimenté par toute
// connexion (mot de passe, inscription, QR), pas seulement le QR. C'est ce qui
// rend la révocation réelle et alimente l'écran « Appareils connectés ».
//
// `device_id` est l'identifiant matériel du téléphone (voir
// TalkyApiClient.currentHardwareId côté mobile) — un même appareil physique
// réutilise donc toujours la même ligne (contrainte UNIQUE alanyaID+device_id).
//
// Cas particulier de la reconnexion d'un appareil RÉVOQUÉ : on ne réactive
// jamais la ligne en place. La réactiver conserverait son `id`, donc le
// `appareilId` porté par les anciens JWT — le refresh token de 30 jours qu'on
// venait de couper redeviendrait valide. On supprime la ligne morte et on en
// crée une neuve, avec un id neuf que les anciens tokens ne portent pas.

const pool = require('../config/db');

const VALID_PLATFORMS = new Set([
  'android', 'ios', 'web', 'macos', 'windows', 'linux', 'unknown',
]);
const VALID_LOGIN_METHODS = new Set(['password', 'register', 'qr']);

const _normalizePlatform = (p) => {
  const v = String(p || 'unknown').trim().toLowerCase();
  return VALID_PLATFORMS.has(v) ? v : 'unknown';
};

/**
 * Enregistre l'appareil ayant réalisé une connexion.
 * @returns {Promise<number|null>} l'id de la ligne `appareils`, ou null en cas
 *   d'échec — l'appelant DOIT alors refuser d'émettre un token, faute de quoi
 *   la session serait invisible et irrévocable.
 */
const recordLogin = async ({
  alanyaID,
  deviceId,
  deviceName,
  platform,
  ipAddress,
  loginMethod,
}) => {
  const devId = String(deviceId || '').trim();
  if (!alanyaID || !devId || devId === 'INDEFINI') return null;
  if (!VALID_LOGIN_METHODS.has(loginMethod)) {
    throw new Error(`login_method invalide: ${loginMethod}`);
  }

  const params = [
    alanyaID,
    devId.slice(0, 128),
    deviceName ? String(deviceName).slice(0, 120) : null,
    _normalizePlatform(platform),
    ipAddress ? String(ipAddress).slice(0, 64) : null,
    loginMethod,
  ];

  try {
    const [existing] = await pool.execute(
      'SELECT id, revoked_at FROM appareils WHERE alanyaID = ? AND device_id = ?',
      [alanyaID, params[1]],
    );

    // Ligne révoquée : on la supprime pour repartir sur un id neuf (voir l'en-tête).
    if (existing.length > 0 && existing[0].revoked_at != null) {
      await pool.execute('DELETE FROM appareils WHERE id = ?', [existing[0].id]);
      existing.length = 0;
    }

    if (existing.length > 0) {
      await pool.execute(
        `UPDATE appareils
            SET device_name = ?, platform = ?, ip_address = ?, login_method = ?,
                last_active_at = NOW()
          WHERE id = ?`,
        [params[2], params[3], params[4], params[5], existing[0].id],
      );
      return existing[0].id;
    }

    const [result] = await pool.execute(
      `INSERT INTO appareils
         (alanyaID, device_id, device_name, platform, ip_address, login_method, created_at, last_active_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      params,
    );
    return result.insertId || null;
  } catch (error) {
    console.warn('[deviceSessionService] recordLogin failed:', error.message);
    return null;
  }
};

const touchLastActive = async (appareilId) => {
  if (!appareilId) return;
  try {
    await pool.execute(
      'UPDATE appareils SET last_active_at = NOW() WHERE id = ? AND revoked_at IS NULL',
      [appareilId],
    );
  } catch (error) {
    console.warn('[deviceSessionService] touchLastActive failed:', error.message);
  }
};

module.exports = { recordLogin, touchLastActive, normalizePlatform: _normalizePlatform };
