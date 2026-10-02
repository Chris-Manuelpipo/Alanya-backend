/**
 * Cache court `alanyaID` → identifiants de ses appareils actifs. TTL 60 s.
 *
 * ── À quoi ça sert, exactement ──
 *
 * Un message chiffré part en N enveloppes, une par appareil cible. Le serveur
 * doit choisir l'événement à émettre vers chacune : `message:sent` pour les
 * AUTRES appareils de l'expéditeur — c'est son propre message qui s'affiche
 * chez lui, déjà au ✓ — et `message:received` pour ceux des destinataires.
 *
 * Il faut donc savoir à qui appartient chaque `appareil_id`. La réponse ne
 * peut pas venir du client : il suffirait d'étiqueter l'appareil d'un
 * correspondant comme « le mien » pour lui faire afficher un message entrant
 * comme un message qu'il aurait envoyé. Ce n'est pas une faille de
 * confidentialité — le contenu reste scellé pour lui — mais c'est une bulle
 * attribuée au mauvais auteur, et rien côté destinataire ne permettrait de le
 * détecter.
 *
 * ── Pourquoi un cache, et pourquoi 60 secondes ──
 *
 * La liste des appareils d'un compte change rarement — un enrôlement, une
 * révocation — et se relit à chaque message envoyé. TTL seul, sans
 * invalidation : 60 secondes de retard signifient qu'un appareil tout juste
 * enrôlé reçoit `message:received` au lieu de `message:sent` pendant une
 * minute. Il affiche alors le message comme entrant au lieu de sortant, et la
 * resynchronisation suivante corrige l'attribution. C'est une imperfection
 * passagère et bornée, pas une perte.
 *
 * Même forme que `conversationParticipantsCache`, pour que les deux se
 * relisent ensemble.
 */

const TTL_MS = 60_000;
const _cache = new Map();

/** @returns {Set<number>|null} ids d'appareils, ou null si absent/périmé. */
function getCachedSenderDevices(alanyaID) {
  const entry = _cache.get(Number(alanyaID));
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) {
    _cache.delete(Number(alanyaID));
    return null;
  }
  return entry.ids;
}

function setCachedSenderDevices(alanyaID, ids) {
  _cache.set(Number(alanyaID), {
    at: Date.now(),
    ids: ids instanceof Set ? ids : new Set((ids || []).map(Number)),
  });
  // Garde-fou mémoire : purge opportuniste au-delà de 500 comptes.
  if (_cache.size > 500) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}

/**
 * À appeler quand la liste change, pour ne pas attendre le TTL : enrôlement
 * d'un appareil, révocation. Facultatif — le TTL rattrape de toute façon.
 */
function invalidateSenderDevices(alanyaID) {
  _cache.delete(Number(alanyaID));
}

module.exports = {
  getCachedSenderDevices,
  setCachedSenderDevices,
  invalidateSenderDevices,
};
