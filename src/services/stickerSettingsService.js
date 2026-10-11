/**
 * Interrupteurs de lancement des stickers : lecture en cache court, règle de
 * cohorte, décision « ce compte voit-il les stickers ? ».
 *
 * Une seule ligne (`sticker_settings`, id = 1, migration 097). Même patron que
 * `e2eeSettingsService` : la valeur est lue à chaque envoi de sticker et à
 * chaque appel de `/api/stickers/*`, et ne change qu'à chaque palier du
 * déploiement.
 *
 * ── Une base incomplète n'ouvre rien, mais ne fige pas une panne ──
 *
 * Table absente (migration non jouée) ou ligne absente : FERMÉ. C'est
 * l'interrupteur de la fonctionnalité elle-même qui retombe sur « éteint » —
 * à ne pas confondre avec le verrou Plus (`stickerMessage`), qui, lui, ne
 * ferme jamais faute de calcul.
 *
 * Lecture en ÉCHEC (base injoignable, driver en erreur) : `getStickerSettings`
 * LÈVE `StickerSettingsInaccessibles`. L'appelant choisit :
 *   - les routes `/api/stickers/*` (`requireStickers`) ferment (404 générique) ;
 *   - l'envoi d'un sticker (`stickerMessage`) répond 503 RETRYABLE — jamais
 *     un `STICKER_*` terminal qui ferait marquer la bulle en échec définitif
 *     alors que la base peut revenir dans la seconde qui suit.
 *
 * L'échec n'est PAS mis en cache (contrairement au repli « ligne absente ») :
 * un cache de 30 s transformerait une panne transitoire en « stickers
 * fermés », et une base qui revient serait ignorée pendant toute la fenêtre.
 *
 * Le cache vit dans le processus : une bascule est visible des autres
 * instances au plus tard 30 secondes après. Il n'y a rien à reprendre au
 * redémarrage de pm2 : la valeur est relue.
 */

const crypto = require('crypto');
const pool = require('../config/db');
const { parseCohortIds } = require('./e2eeSettingsService');

const TTL_MS = 30_000;

let _cache = null;

/** Valeurs de la migration 097 : tout fermé. */
const DEFAULTS = Object.freeze({
  id: 1,
  enabled: 0,
  creation_enabled: 0,
  animated_enabled: 0,
  cohort_ids: null,
  cohort_percent: 0,
  min_app_version: null,
  updated_at: null,
});

/**
 * Réglages illisibles : base injoignable, table absente (migration non jouée),
 * driver en erreur. Distinct du repli « ligne absente », qui, lui, est une
 * valeur lue et connue (FERMÉ). L'appelant décide : 404 sur les routes,
 * 503 retryable à l'envoi.
 */
class StickerSettingsInaccessibles extends Error {
  constructor(cause) {
    super('Réglages des stickers illisibles');
    this.name = 'StickerSettingsInaccessibles';
    this.code = cause?.code || 'STICKER_SETTINGS_UNREADABLE';
  }
}

/**
 * Le seau d'un compte, de 0 à 99. Haché stable : monter le pourcentage n'en
 * fait sortir personne. Le préfixe sépare ce tirage de celui de l'E2EE — un
 * compte tôt dans la cohorte du chiffrement ne l'est pas automatiquement ici.
 */
function cohortBucket(alanyaID) {
  const h = crypto.createHash('sha256').update(`alanya-stickers-cohorte:${alanyaID}`).digest();
  return h.readUInt32BE(0) % 100;
}

/** Le compte fait-il partie de la cohorte ? Fonction pure. */
function estDansCohorte(alanyaID, settings) {
  const id = Number(alanyaID);
  if (!Number.isInteger(id) || id <= 0) return false;
  if (parseCohortIds(settings.cohort_ids).has(id)) return true;
  const pourcent = Number(settings.cohort_percent) || 0;
  return pourcent > 0 && cohortBucket(id) < pourcent;
}

/**
 * Cohorte des stickers : sans liste ni pourcentage, personne n'y est et
 * `enabled = 1` seul n'ouvre RIEN. `cohort_percent = 100` ouvre à tous.
 * Fonction pure, testée sans base.
 */
function stickersOuverts(alanyaID, settings) {
  return Number(settings?.enabled) === 1 && estDansCohorte(alanyaID, settings);
}

/**
 * Réglage global, en cache 30 s par instance.
 *
 * @throws {StickerSettingsInaccessibles} lecture en échec — rien n'est mis en
 *         cache, l'appelant décide de la posture (routes : fermer ; envoi :
 *         retryable)
 * @returns {Promise<object>}
 */
async function getStickerSettings() {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.value;

  let row = null;
  try {
    const [rows] = await pool.execute('SELECT * FROM sticker_settings WHERE id = 1');
    row = rows[0] || null;
  } catch (error) {
    console.warn('[stickerSettings] lecture impossible :', error.code || error.message);
    throw new StickerSettingsInaccessibles(error);
  }

  const value = row ? { ...DEFAULTS, ...row } : { ...DEFAULTS };
  _cache = { at: Date.now(), value };
  return value;
}

function invalidateStickerSettings() {
  _cache = null;
}

/** Ce compte voit-il les stickers (V1a) ? */
async function peutUtiliserStickers(alanyaID) {
  return stickersOuverts(alanyaID, await getStickerSettings());
}

module.exports = {
  DEFAULTS,
  StickerSettingsInaccessibles,
  cohortBucket,
  estDansCohorte,
  stickersOuverts,
  getStickerSettings,
  invalidateStickerSettings,
  peutUtiliserStickers,
};
