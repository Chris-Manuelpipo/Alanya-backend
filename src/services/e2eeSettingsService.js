/**
 * L'interrupteur du chiffrement de bout en bout : lecture en cache court,
 * écriture qui invalide le cache, et la règle de cohorte.
 *
 * Une seule ligne (`e2ee_settings`, id = 1, migration 094). Même patron que
 * `securitySettingsService` : la valeur est lue à chaque publication de clé et
 * à chaque envoi chiffré, et ne change qu'à chaque palier du déploiement.
 *
 * ── Une base incomplète n'ouvre rien ──
 *
 * Table absente (migration non jouée) ou lecture en échec : tout est fermé.
 * C'est l'inverse du verrouillage d'appareil, et pour la même raison — le
 * repli est toujours « ne rien changer à ce qui marche aujourd'hui ». Fermé,
 * le chiffrement laisse la messagerie exactement telle qu'elle est.
 *
 * ── Le délai de propagation est assumé ──
 *
 * Le cache vit dans le processus : une bascule est visible des autres
 * instances au plus tard 30 secondes après.
 */

const crypto = require('crypto');
const pool = require('../config/db');

const TTL_MS = 30_000;

/** Plafond de la liste explicite : des comptes internes, pas une cohorte. */
const COHORT_IDS_MAX = 500;

let _cache = null;

/** Valeurs de la migration 094, si la ligne ou la table manque. */
const DEFAULTS = Object.freeze({
  id: 1,
  enrol_enabled: 0,
  activate_enabled: 0,
  cohort_percent: 0,
  cohort_ids: null,
  updated_at: null,
});

/** Erreur de validation d'une mise à jour : porte le code d'API. */
class ReglageInvalide extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID_E2EE_SETTING';
  }
}

/**
 * La liste explicite, telle que rangée en base (JSON).
 *
 * Tolérante à la lecture : un JSON abîmé vaut une liste vide, jamais une
 * exception. Une liste illisible ne doit pas faire entrer qui que ce soit.
 */
function parseCohortIds(raw) {
  if (raw == null || raw === '') return new Set();
  let liste;
  try {
    liste = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return new Set();
  }
  if (!Array.isArray(liste)) return new Set();
  return new Set(
    liste.map(Number).filter((n) => Number.isInteger(n) && n > 0),
  );
}

/**
 * Le seau d'un compte, de 0 à 99.
 *
 * Un haché et non `alanyaID % 100` : les identifiants sont attribués dans
 * l'ordre d'inscription, et un modulo ferait entrer les comptes par tranches
 * d'ancienneté. Le préfixe sépare ce tirage de tout autre fait sur le même
 * identifiant. Stable : le même compte tombe toujours dans le même seau, donc
 * monter le pourcentage n'en fait sortir personne.
 */
function cohortBucket(alanyaID) {
  const h = crypto.createHash('sha256').update(`alanya-e2ee-cohorte:${alanyaID}`).digest();
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
 * Réglage global, en cache 30 s par instance.
 * @returns {Promise<object>}
 */
async function getE2eeSettings() {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.value;

  let row = null;
  try {
    const [rows] = await pool.execute('SELECT * FROM e2ee_settings WHERE id = 1');
    row = rows[0] || null;
  } catch (error) {
    // Le repli est mis en cache lui aussi : sans cela, chaque envoi referait
    // la requête et réécrirait cet avertissement.
    console.warn('[e2eeSettings] lecture impossible, chiffrement fermé :', error.message);
    _cache = { at: Date.now(), value: { ...DEFAULTS } };
    return _cache.value;
  }

  const value = row ? { ...DEFAULTS, ...row } : { ...DEFAULTS };
  _cache = { at: Date.now(), value };
  return value;
}

function invalidateE2eeSettings() {
  _cache = null;
}

/**
 * Cet appareil peut-il publier ses clés ? Premier cran du déploiement.
 * @returns {Promise<boolean>}
 */
async function peutPublier(alanyaID) {
  const s = await getE2eeSettings();
  return Number(s.enrol_enabled) === 1 && estDansCohorte(alanyaID, s);
}

/**
 * Une conversation entre ces comptes peut-elle passer en chiffré ?
 *
 * Exige aussi le premier cran : activer sans annuaire produirait des
 * conversations chiffrées pour des appareils sans clés.
 * @returns {Promise<boolean>}
 */
async function peutActiver(...alanyaIDs) {
  const s = await getE2eeSettings();
  if (Number(s.enrol_enabled) !== 1 || Number(s.activate_enabled) !== 1) return false;
  return alanyaIDs.length > 0 && alanyaIDs.every((id) => estDansCohorte(id, s));
}

/**
 * Valide une mise à jour partielle venue du back-office.
 *
 * Types stricts : un `"false"` venu d'un formulaire mal câblé ne doit pas
 * ouvrir le chiffrement à tout le monde.
 *
 * @returns {object} colonnes SQL à écrire
 */
function normaliseMiseAJour(body = {}) {
  const sortie = {};

  for (const [champ, colonne] of [
    ['enrolEnabled', 'enrol_enabled'],
    ['activateEnabled', 'activate_enabled'],
  ]) {
    if (body[champ] === undefined) continue;
    if (typeof body[champ] !== 'boolean') {
      throw new ReglageInvalide(`${champ} doit être un booléen`);
    }
    sortie[colonne] = body[champ] ? 1 : 0;
  }

  if (body.cohortPercent !== undefined) {
    const n = body.cohortPercent;
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      throw new ReglageInvalide('cohortPercent doit être un entier de 0 à 100');
    }
    sortie.cohort_percent = n;
  }

  if (body.cohortIds !== undefined) {
    const liste = body.cohortIds;
    if (!Array.isArray(liste)) {
      throw new ReglageInvalide('cohortIds doit être une liste');
    }
    if (liste.length > COHORT_IDS_MAX) {
      throw new ReglageInvalide(`cohortIds limité à ${COHORT_IDS_MAX} comptes`);
    }
    if (!liste.every((n) => Number.isInteger(n) && n > 0)) {
      throw new ReglageInvalide('cohortIds ne contient que des alanyaID');
    }
    sortie.cohort_ids = JSON.stringify([...new Set(liste)].sort((a, b) => a - b));
  }

  if (Object.keys(sortie).length === 0) {
    throw new ReglageInvalide('aucun réglage à modifier');
  }
  return sortie;
}

/**
 * Applique une mise à jour validée par `normaliseMiseAJour`.
 *
 * INSERT ... ON DUPLICATE KEY UPDATE et non UPDATE seul : un réglage qui
 * échouerait en silence parce que la ligne manque n'est pas un réglage.
 * L'erreur n'est pas rattrapée : une écriture qui n'a pas eu lieu doit
 * remonter à l'administrateur.
 */
async function setE2eeSettings(colonnes) {
  // Relue sans cache : la fusion d'une mise à jour partielle sur une valeur
  // vieille de 30 s défairait la bascule qu'une autre instance vient de faire.
  invalidateE2eeSettings();
  const actuel = await getE2eeSettings();
  const v = {
    enrol_enabled: Number(actuel.enrol_enabled) === 1 ? 1 : 0,
    activate_enabled: Number(actuel.activate_enabled) === 1 ? 1 : 0,
    cohort_percent: Number(actuel.cohort_percent) || 0,
    cohort_ids: actuel.cohort_ids ?? null,
    ...colonnes,
  };
  await pool.execute(
    `INSERT INTO e2ee_settings
       (id, enrol_enabled, activate_enabled, cohort_percent, cohort_ids)
     VALUES (1, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       enrol_enabled    = VALUES(enrol_enabled),
       activate_enabled = VALUES(activate_enabled),
       cohort_percent   = VALUES(cohort_percent),
       cohort_ids       = VALUES(cohort_ids)`,
    [v.enrol_enabled, v.activate_enabled, v.cohort_percent, v.cohort_ids],
  );
  invalidateE2eeSettings();
  return getE2eeSettings();
}

module.exports = {
  COHORT_IDS_MAX,
  ReglageInvalide,
  parseCohortIds,
  cohortBucket,
  estDansCohorte,
  getE2eeSettings,
  invalidateE2eeSettings,
  peutPublier,
  peutActiver,
  normaliseMiseAJour,
  setE2eeSettings,
};
