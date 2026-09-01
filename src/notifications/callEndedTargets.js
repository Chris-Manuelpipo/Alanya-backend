/**
 * Qui doit recevoir le push `call_ended`.
 *
 * La décision vivait en double : une boucle dans `notificationService` et une
 * réimplémentation dans son test — lequel restait donc vert quoi qu'il arrive à
 * la production. Elle est ici, une seule fois, et le test importe celle-ci.
 */

const { normalizeDeviceId } = require('../utils/deviceId');

/**
 * Filtre les cibles d'un `call_ended`.
 *
 * Deux règles, et la seconde a coûté cher :
 *
 * — On n'envoie jamais à l'appareil qu'on veut épargner, celui qui vient de
 *   décrocher. Un `call_ended` porte le callId exact de l'appel en cours : il
 *   raccrocherait de lui-même.
 *
 * — Une cible sans identifiant d'appareil clair n'est écartée que **s'il y a
 *   quelqu'un à épargner**. La garde existe pour ne pas tuer le gagnant quand
 *   l'exclusion est ambiguë ; sans exclusion demandée, il n'y a personne à
 *   tuer. L'appliquer quand même privait les comptes anciens — ceux dont
 *   `device_ID` vaut `INDEFINI`, donc sans identifiant normalisable — de
 *   l'ordre d'arrêt : ils recevaient le push qui fait sonner, jamais celui qui
 *   arrête, et le téléphone sonnait jusqu'à l'expiration du plugin.
 *
 * @param {Array<{deviceId: *, fcmToken: *}>} targets
 * @param {*} excludeDeviceIdRaw
 * @returns {Array} les cibles à notifier, dans l'ordre reçu
 */
function filterCallEndedTargets(targets, excludeDeviceIdRaw) {
  const excludeDeviceId = normalizeDeviceId(excludeDeviceIdRaw);
  const out = [];
  for (const target of targets || []) {
    // Une entrée vide ferait lever l'appelant sur `target.fcmToken`.
    if (!target) continue;
    const targetDid = normalizeDeviceId(target.deviceId);
    if (!targetDid && excludeDeviceId) continue;
    if (excludeDeviceId && targetDid === excludeDeviceId) continue;
    out.push(target);
  }
  return out;
}

module.exports = { filterCallEndedTargets };
