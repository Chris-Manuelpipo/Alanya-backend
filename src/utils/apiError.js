/**
 * Réponses d'erreur à code stable.
 *
 * L'audit des erreurs de 09/2026 a montré que l'application affichait la prose
 * de `error` faute de mieux : sur 604 réponses d'erreur, 135 seulement
 * portaient un `code`. Cette prose est écrite en français, jamais traduite, et
 * laisse parfois filtrer un identifiant de table — un utilisateur en chinois y
 * lisait du français, et parfois `ER_NO_SUCH_TABLE`.
 *
 * Le contrat est désormais :
 *
 * - `code` — chaîne machine stable, **le contrat**. L'application le traduit.
 *   Il ne change jamais sans changer de nom : le renommer casse les clients
 *   déployés, qui ne se mettent pas à jour d'un bloc.
 * - `error` — prose lisible, **pour les journaux et les clients anciens**.
 *   Elle peut être reformulée librement : plus personne ne s'en sert pour
 *   décider quoi afficher.
 *
 * Le catalogue des codes vit dans `docs/error-codes.md`, partagé avec
 * l'application (`lib/core/errors/error_presenter.dart`).
 */

/** Codes réservés, jamais renvoyés tels quels par une route métier. */
const CODE_INTERNE = 'INTERNAL';

/**
 * Motifs qui trahissent une erreur de driver ou de base remontée telle quelle.
 *
 * Un message MySQL ne doit jamais franchir la frontière HTTP : il nomme les
 * tables, les colonnes et parfois les valeurs. Voir [scrubMessage].
 */
const MOTIFS_INTERNES = [
  /^ER_[A-Z_]+/, // codes d'erreur MySQL (ER_NO_SUCH_TABLE, ER_DUP_ENTRY…)
  /\bECONNREFUSED\b|\bETIMEDOUT\b|\bENOTFOUND\b/, // réseau bas niveau
  /\bSQLSTATE\b/i,
  /\bat [A-Za-z0-9_$.]+ \(.*:\d+:\d+\)/, // trace de pile
  /\/(?:home|var|usr|opt|srv)\//, // chemin absolu du serveur
];

/**
 * Remplace un message technique par un texte neutre.
 *
 * Renvoie le message d'origine s'il est présentable, sinon une phrase générique.
 * Le message d'origine reste dans les journaux de l'appelant : c'est la sortie
 * HTTP qu'on assainit, pas la capacité de diagnostic.
 */
function scrubMessage(message) {
  if (typeof message !== 'string' || message.trim() === '') {
    return 'Erreur interne';
  }
  if (MOTIFS_INTERNES.some((m) => m.test(message))) {
    return 'Erreur interne';
  }
  return message;
}

/**
 * Envoie une réponse d'erreur portant un code stable.
 *
 * @param {object} res       réponse Express
 * @param {number} status    statut HTTP
 * @param {string} code      code machine stable (MAJUSCULES_SOULIGNÉES)
 * @param {string} [message] prose pour les journaux et les clients anciens
 * @param {object} [extra]   champs supplémentaires (limites, délais…)
 */
function fail(res, status, code, message, extra) {
  // `extra` est appliqué d'abord : `code` et `error` sont le contrat, ils ne
  // doivent pas pouvoir être écrasés par un champ d'appoint mal nommé.
  const corps = { ...(extra && typeof extra === 'object' ? extra : {}) };
  corps.error = scrubMessage(message || code);
  corps.code = code;
  return res.status(status).json(corps);
}

/**
 * Réponse 500 pour une exception non prévue.
 *
 * Ne laisse jamais sortir `err.message` : c'est par là que les erreurs MySQL
 * s'échappaient. L'exception reste à la charge de l'appelant pour le journal.
 */
function failInternal(res, message) {
  return res.status(500).json({ error: scrubMessage(message), code: CODE_INTERNE });
}

module.exports = { fail, failInternal, scrubMessage, CODE_INTERNE };
