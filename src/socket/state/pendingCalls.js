// Buffer en mémoire des appels entrants en attente, indexé par destinataire.
// Permet de rejouer l'event `incoming_call` (et son offre WebRTC) quand le
// destinataire se (re)connecte après avoir été réveillé par un push FCM alors
// que son app était fermée — sinon l'offre, émise en temps réel, est perdue.

const TTL_MS = 60 * 1000; // sonnerie CallKit = 30 s ; marge incluse.

// targetID(number) -> { payload, expiresAt }
const _pending = new Map();

function set(targetID, payload) {
  if (targetID == null) return;
  _pending.set(targetID, { payload, expiresAt: Date.now() + TTL_MS });
}

function get(targetID) {
  const entry = _pending.get(targetID);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _pending.delete(targetID);
    return null;
  }
  return entry.payload;
}

function clear(targetID) {
  if (targetID == null) return;
  _pending.delete(targetID);
}

module.exports = { set, get, clear };
