/**
 * L'interrupteur du verrouillage d'appareil : lecture en cache court, écriture
 * qui invalide le cache.
 *
 * Une seule ligne (`security_settings`, id = 1, migration 084). Même patron que
 * `src/services/billing/settings.js` : la connexion lit ce réglage à chaque
 * tentative, une requête par login serait du gaspillage pour une valeur qui ne
 * change qu'une fois par an.
 *
 * ── Le délai de propagation est assumé ──
 *
 * Le cache vit dans le processus : la bascule faite depuis le back-office est
 * immédiate sur l'instance qui l'exécute, et visible des autres au plus tard 30
 * secondes après. C'est déjà ce que fait l'interrupteur du payant. L'écran de
 * réglages le dit à l'administrateur, sans quoi il croirait la bascule perdue.
 *
 * ── Une base incomplète ne verrouille personne ──
 *
 * Si la table manque (migration non jouée) ou si la lecture échoue, on rend 0 :
 * le verrou reste inerte. Le contraire — refuser par défaut — transformerait un
 * oubli de déploiement en mise à la porte de tous les utilisateurs, y compris
 * de ceux qui n'auraient aucun moyen de revenir.
 */

const pool = require('../config/db');

const TTL_MS = 30_000;
let _cache = null;

/** Valeurs de la migration 084, si la ligne ou la table manque. */
const DEFAULTS = Object.freeze({
  id: 1,
  device_binding_enabled: 0,
  updated_at: null,
});

/**
 * Réglage global, en cache 30 s par instance.
 * @returns {Promise<{id:number, device_binding_enabled:number, updated_at:Date|null}>}
 */
async function getSecuritySettings() {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.value;

  let row = null;
  try {
    const [rows] = await pool.execute('SELECT * FROM security_settings WHERE id = 1');
    row = rows[0] || null;
  } catch (error) {
    // Le repli est mis en cache lui aussi : sur une base sans la table, sans
    // cela, chaque connexion referait la requête et réécrirait cet
    // avertissement dans les journaux.
    console.warn('[securitySettings] lecture impossible, verrou inactif :', error.message);
    _cache = { at: Date.now(), value: { ...DEFAULTS } };
    return _cache.value;
  }

  const value = row ? { ...DEFAULTS, ...row } : { ...DEFAULTS };
  _cache = { at: Date.now(), value };
  return value;
}

function invalidateSecuritySettings() {
  _cache = null;
}

/**
 * Le verrou est-il armé ? Seule question que se pose la garde de `login`.
 * @returns {Promise<boolean>}
 */
async function isDeviceBindingEnabled() {
  const settings = await getSecuritySettings();
  return Number(settings.device_binding_enabled) === 1;
}

/**
 * Arme ou désarme le verrou.
 *
 * INSERT ... ON DUPLICATE KEY UPDATE et non UPDATE seul : la ligne est posée
 * par la migration, mais un réglage de sécurité qui échouerait silencieusement
 * parce qu'une ligne manque n'est pas un réglage.
 *
 * L'erreur n'est pas rattrapée ici, contrairement à la lecture : une écriture
 * qui n'a pas eu lieu doit remonter à l'administrateur, pas se taire.
 *
 * @param {boolean} enabled
 */
async function setDeviceBindingEnabled(enabled) {
  const valeur = enabled ? 1 : 0;
  await pool.execute(
    `INSERT INTO security_settings (id, device_binding_enabled) VALUES (1, ?)
     ON DUPLICATE KEY UPDATE device_binding_enabled = VALUES(device_binding_enabled)`,
    [valeur],
  );
  invalidateSecuritySettings();
  return getSecuritySettings();
}

module.exports = {
  getSecuritySettings,
  invalidateSecuritySettings,
  isDeviceBindingEnabled,
  setDeviceBindingEnabled,
};
