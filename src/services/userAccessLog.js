// Journal des accès au compte (table `userAccess`) — la trace que lit l'écran
// « Historique des connexions » d'un utilisateur, et que l'écran Analytics
// agrège en camembert des systèmes.
//
// Extrait de authCustomController parce que l'approbation par QR doit écrire
// ici elle aussi, et qu'elle vit dans un autre contrôleur. Le déplacement a
// changé la signature au passage : plus de `req`. Voir `journaliserAcces`.

const pool = require('../config/db');

// Libellés de plateforme tels que la colonne les contient déjà : le CASE de
// l'agrégat analytics range 'Android' et 'iOS' par LIKE insensible à la casse,
// mais laisse passer les autres valeurs telles quelles — écrire 'macos' à côté
// de 'macOS' créerait deux parts distinctes pour un même système.
//
// L'entrée vient de `normalizePlatform` (deviceSessionService), dont le
// vocabulaire est fermé et en minuscules.
const _LIBELLES_OS = {
  android: 'Android',
  ios: 'iOS',
  web: 'Web',
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
};

const libelleOs = (plateforme) => {
  const v = String(plateforme || '').trim().toLowerCase();
  return _LIBELLES_OS[v] || null;
};

/**
 * Déduit le système depuis l'en-tête User-Agent. Repli pour les chemins où le
 * client n'annonce pas sa plateforme : l'application mobile l'envoie dans le
 * corps (`os_system`), un navigateur non.
 */
const osDepuisUserAgent = (ua) => {
  if (!ua) return null;
  const s = ua.toLowerCase();
  if (s.includes('android')) return 'Android';
  if (s.includes('iphone') || s.includes('ipad') || s.includes('ios')) return 'iOS';
  if (s.includes('mac os')) return 'macOS';
  if (s.includes('windows')) return 'Windows';
  if (s.includes('linux')) return 'Linux';
  return null;
};

/**
 * Journalise un accès au compte.
 *
 * Best-effort : ne fait jamais échouer l'appelant. Une trace perdue est moins
 * grave qu'une connexion refusée parce que son journal n'a pas pu s'écrire.
 *
 * Prend l'IP en paramètre plutôt qu'un `req`, contrairement à la version qu'elle
 * remplace. L'approbation par QR est la raison : la requête y est celle du
 * téléphone QUI APPROUVE, alors que la ligne doit décrire le téléphone qui
 * demande. Un `req` dans la signature invitait à écrire la mauvaise IP.
 *
 * @param {number} alanyaID
 * @param {object} opts
 * @param {string} [opts.device]     libellé lisible (marque + modèle)
 * @param {string} [opts.osSystem]   plateforme, minuscule ou déjà capitalisée
 * @param {string} [opts.userAgent]  repli quand `osSystem` est absent
 * @param {string} [opts.ipAddress]
 * @param {'login'|'inscription'|'qr'|'recovery'|'refus'} opts.origine
 */
const journaliserAcces = async (
  alanyaID,
  { device, osSystem, userAgent, ipAddress, origine } = {},
) => {
  try {
    const os = libelleOs(osSystem) || osSystem || osDepuisUserAgent(userAgent) || 'INDEFINI';
    await pool.execute(
      `INSERT INTO userAccess (alanyaID, device, dateLogin, ipAdress, os_system, origine)
       VALUES (?, ?, NOW(), ?, ?, ?)`,
      [alanyaID, device || 'INDEFINI', ipAddress || 'INDEFINI', os, origine || 'login'],
    );
  } catch (error) {
    console.warn('[userAccess] insert failed:', error.message);
  }
};

module.exports = { journaliserAcces, libelleOs, osDepuisUserAgent };
