/**
 * `stickers:sync` — prévient les autres appareils du compte (room `user_<id>`)
 * qu'un pack ou un favori a changé. Même mécanique que `inbox:sync`.
 *
 * Payload (contrat §6) : `{ reason: 'packs'|'favorites'|'catalog', version }`.
 * L'application refait `GET /api/stickers/me` (et `/catalog` pour `catalog`).
 * `version` est l'instant de la modification en secondes : monotone, et
 * indicatif — l'événement ne porte aucune donnée, le client relit toujours.
 */

const REASONS = Object.freeze(['packs', 'favorites', 'catalog']);

function syncPayload(reason, now = Date.now()) {
  if (!REASONS.includes(reason)) throw new Error(`raison de synchronisation inconnue : ${reason}`);
  return { reason, version: Math.floor(now / 1000) };
}

/** Émission vers tous les appareils du compte, l'appareil émetteur compris. */
function emitStickersSync(io, alanyaID, reason) {
  if (!io) return;
  io.to(`user_${alanyaID}`).emit('stickers:sync', syncPayload(reason));
}

module.exports = { REASONS, syncPayload, emitStickersSync };
