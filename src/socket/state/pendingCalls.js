// Buffer en mémoire des appels entrants en attente, indexé par destinataire.
// Permet de rejouer l'event `incoming_call` (et son offre WebRTC) quand le
// destinataire se (re)connecte après avoir été réveillé par un push FCM alors
// que son app était fermée — sinon l'offre, émise en temps réel, est perdue.

const TTL_MS = 60 * 1000; // sonnerie CallKit = 30 s ; marge incluse.
const REPLAY_GUARD_MS = 8000;

// targetID(number) -> { payload, callId, createdAt, expiresAt, deliveredAt, attempts }
const _pending = new Map();

function set(targetID, payload) {
  if (targetID == null) return;
  const now = Date.now();
  _pending.set(targetID, {
    payload,
    callId: payload?.callId ?? null,
    createdAt: now,
    expiresAt: now + TTL_MS,
    deliveredAt: null,
    attempts: 0,
  });
}

function _getEntry(targetID) {
  const entry = _pending.get(targetID);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _pending.delete(targetID);
    return null;
  }
  return entry;
}

function get(targetID) {
  const entry = _getEntry(targetID);
  if (!entry) return null;
  return entry.payload;
}

function getReplayable(targetID) {
  const entry = _getEntry(targetID);
  if (!entry) return null;
  if (entry.deliveredAt) {
    return null;
  }
  if (entry.attempts > 0 && Date.now() - entry.createdAt > REPLAY_GUARD_MS) {
    return null;
  }
  return entry.payload;
}

function markDelivered(targetID, source = 'socket') {
  const entry = _getEntry(targetID);
  if (!entry) return null;
  entry.deliveredAt = Date.now();
  entry.attempts += 1;
  return { callId: entry.callId, source, attempts: entry.attempts };
}

function clear(targetID) {
  if (targetID == null) return;
  _pending.delete(targetID);
}

// Réinitialise la livraison quand le socket se déconnecte (app tuée en arrière-plan
// après réception live de l'offre) pour permettre le rejeu à la reconnexion.
function markUndelivered(targetID) {
  const entry = _getEntry(targetID);
  if (!entry) return;
  entry.deliveredAt = null;
  entry.attempts = 0;
}

module.exports = { set, get, getReplayable, markDelivered, clear, markUndelivered };
