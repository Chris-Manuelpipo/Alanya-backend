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
const { emitToUser, disconnectAppareilSockets } = require('../utils/userSocketRegistry');

const VALID_PLATFORMS = new Set([
  'android', 'ios', 'web', 'macos', 'windows', 'linux', 'unknown',
]);
// 'recovery' = enrôlement par réinitialisation du mot de passe, la voie de
// secours quand le téléphone enrôlé est perdu (migration 083). Nommée à part
// pour qu'un tel enrôlement reste reconnaissable dans « Appareils connectés »
// et dans une enquête après vol.
const VALID_LOGIN_METHODS = new Set(['password', 'register', 'qr', 'recovery']);

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

/**
 * Cet appareil est-il déjà enrôlé sur ce compte, et toujours actif ?
 *
 * Le `slice(0, 128)` reprend celui de `recordLogin` : sans lui, un identifiant
 * plus long que la colonne serait « inconnu » alors que sa version tronquée est
 * en base, et son propriétaire se verrait refuser l'entrée à chaque connexion.
 *
 * Une erreur de base remonte à l'appelant plutôt que de valoir `false` : un
 * incident SQL ne doit pas se traduire par un refus silencieux, c'est-à-dire par
 * des comptes bloqués pour une raison qu'aucun écran n'explique.
 *
 * @returns {Promise<boolean>}
 */
const isTrustedDevice = async (alanyaID, deviceId) => {
  const devId = String(deviceId || '').trim();
  if (!alanyaID || !devId || devId === 'INDEFINI') return false;

  const [rows] = await pool.execute(
    `SELECT id FROM appareils
      WHERE alanyaID = ? AND device_id = ? AND revoked_at IS NULL
      LIMIT 1`,
    [alanyaID, devId.slice(0, 128)],
  );
  return rows.length > 0;
};

/**
 * Nombre d'appareils actifs du compte. Zéro signifie qu'aucune approbation par
 * QR n'est possible : c'est ce qui autorise la garde de `login` à laisser
 * passer un appareil inconnu plutôt que d'enfermer le compte dehors.
 *
 * @returns {Promise<number>}
 */
const countActiveDevices = async (alanyaID) => {
  if (!alanyaID) return 0;
  const [rows] = await pool.execute(
    'SELECT COUNT(*) AS total FROM appareils WHERE alanyaID = ? AND revoked_at IS NULL',
    [alanyaID],
  );
  return Number(rows[0]?.total) || 0;
};

/**
 * Révoque tous les appareils du compte sauf celui-ci. Utilisé par la
 * réinitialisation du mot de passe : si elle sert à reprendre la main sur un
 * téléphone volé, laisser le voleur connecté n'aurait aucun sens.
 *
 * Refuse d'agir sans `appareilId` : « tout révoquer sauf rien » serait une
 * déconnexion totale du compte obtenue par omission.
 *
 * On lit les lignes avant de les révoquer, plutôt que de compter les lignes
 * touchées par un UPDATE : révoquer sans savoir QUI a été révoqué interdit de
 * couper le temps réel derrière (voir `disconnectRevoked`), et une révocation
 * qui laisse la socket ouverte n'est pas une révocation.
 *
 * @returns {Promise<Array<{id:number, deviceId:string}>>} appareils révoqués
 */
const revokeAllExcept = async (alanyaID, appareilId) => {
  if (!alanyaID || !appareilId) return [];

  const [rows] = await pool.execute(
    `SELECT id, device_id FROM appareils
      WHERE alanyaID = ? AND id <> ? AND revoked_at IS NULL`,
    [alanyaID, appareilId],
  );
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  await pool.execute(
    `UPDATE appareils SET revoked_at = NOW()
      WHERE alanyaID = ? AND revoked_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
    [alanyaID, ...ids],
  );
  return rows.map((r) => ({ id: r.id, deviceId: r.device_id }));
};

/**
 * Coupe le temps réel des appareils qu'on vient de révoquer : l'événement que
 * les clients écoutent pour se déconnecter proprement, puis la fermeture de
 * leurs sockets.
 *
 * Écrit une fois ici parce que DEUX chemins révoquent : « Appareils connectés »
 * (`revokeDeviceSession`) et la réinitialisation du mot de passe. Sans cet
 * appel, le second laissait les sockets ouvertes — dans le scénario du
 * téléphone volé, qui est sa raison d'être, le voleur continuait de recevoir
 * les messages en temps réel jusqu'à son prochain appel REST, le seul endroit
 * où le 401 du middleware l'aurait arrêté.
 *
 * L'événement part AVANT la fermeture, pour que le client le reçoive avant que
 * sa socket ne tombe. Il est diffusé à tout le compte et porte l'identifiant
 * MATÉRIEL : chaque client se reconnaît lui-même.
 *
 * @param {Array<{id:number, deviceId:string}>} appareils
 * @returns {Promise<number>} sockets fermées
 */
const disconnectRevoked = async (io, alanyaID, appareils) => {
  if (!io || !alanyaID || !Array.isArray(appareils) || appareils.length === 0) return 0;

  let fermees = 0;
  for (const { id, deviceId } of appareils) {
    emitToUser(io, alanyaID, 'auth:device_revoked', { appareilId: id, deviceId });
    fermees += await disconnectAppareilSockets(io, alanyaID, id);
  }
  return fermees;
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

module.exports = {
  recordLogin,
  touchLastActive,
  isTrustedDevice,
  countActiveDevices,
  revokeAllExcept,
  disconnectRevoked,
  normalizePlatform: _normalizePlatform,
};
