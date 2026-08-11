/**
 * Validation des entrées d'un trajet — fonctions PURES, sans base ni réseau.
 *
 * Isolées du contrôleur pour être testables seules : requérir
 * `tripController` charge le pool MySQL et initialise Firebase, ce qui n'a pas
 * sa place dans un test unitaire.
 *
 * C'est ici que vit la règle la plus importante du volet côté serveur :
 * **l'échéance est calculée par le serveur, jamais par le client**. Une horloge
 * de téléphone fausse — ou trafiquée — ne doit pas pouvoir décaler une alerte.
 */

const KINDS = new Set(['taxi', 'meeting', 'sos']);
const NOTE_MAX = 200;
const CLIENT_ID_MAX = 64;
const DEVICE_ID_MAX = 128;

/** Chaîne nettoyée et bornée ; '' devient null (pas de chaîne vide en base). */
const clean = (raw, max) => {
  const v = String(raw ?? '').trim();
  return v === '' ? null : v.slice(0, max);
};

const parseTripId = (raw) => {
  const id = parseInt(raw, 10);
  return Number.isNaN(id) || id <= 0 ? null : id;
};

const parseKind = (raw) => (KINDS.has(raw) ? raw : 'meeting');

/**
 * Résout l'échéance à partir de `etaAt` (ISO 8601) ou `durationMin`.
 *
 * `now` est injectable pour que les tests ne dépendent pas de l'heure courante.
 *
 * @returns {{etaAt: Date}|{error: string}}
 */
const resolveEta = ({ etaAt, durationMin } = {}, maxDurationH = 12, now = Date.now()) => {
  const maxMs = maxDurationH * 3600 * 1000;

  // `durationMin` l'emporte : c'est le chemin normal de l'écran de composition
  // (« dans 30 minutes »), et il n'implique aucune horloge client.
  if (durationMin != null && durationMin !== '') {
    const m = Number(durationMin);
    if (!Number.isFinite(m) || m < 1) return { error: 'durationMin invalide' };
    if (m * 60000 > maxMs) return { error: 'durationMin dépasse la durée maximale' };
    return { etaAt: new Date(now + m * 60000) };
  }

  if (etaAt != null && etaAt !== '') {
    const t = new Date(etaAt).getTime();
    if (!Number.isFinite(t)) return { error: 'etaAt invalide' };
    // Une minute de tolérance : le temps que l'écran de composition soit validé,
    // et pour absorber une dérive d'horloge bénigne.
    if (t < now - 60000) return { error: 'etaAt est dans le passé' };
    if (t - now > maxMs) return { error: 'etaAt dépasse la durée maximale' };
    return { etaAt: new Date(t) };
  }

  return { error: 'etaAt ou durationMin est requis' };
};

/** Format DATETIME MySQL, en UTC — la colonne ne porte pas de fuseau. */
const toSqlDate = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

module.exports = {
  KINDS,
  NOTE_MAX,
  CLIENT_ID_MAX,
  DEVICE_ID_MAX,
  clean,
  parseTripId,
  parseKind,
  resolveEta,
  toSqlDate,
};
