// Registre autoritaire de l'état d'appel 1-à-1, indexé par userId.
//
// Sert à répondre « occupé » (busy) immédiatement quand une cible est déjà en
// train de sonner ou en communication, et à nettoyer proprement les deux
// participants sur tous les états terminaux (réponse, refus, fin, timeout,
// déconnexion).
//
// Statuts possibles : 'idle' (implicite, absent de la map) | 'ringing' | 'in_call'
//
// Chaque entrée : { status, callId, peerId, noAnswerTimer, disconnectTimer,
//                   lastAnswer, isVideo }

const DISCONNECT_GRACE_MS = 45 * 1000;

const _states = new Map(); // userId(Number) -> entry

function get(userId) {
  if (userId == null) return 'idle';
  return _states.get(userId)?.status ?? 'idle';
}

function isBusy(userId) {
  const status = get(userId);
  return status === 'ringing' || status === 'in_call';
}

function getEntry(userId) {
  if (userId == null) return null;
  return _states.get(userId) ?? null;
}

function _clearTimers(entry) {
  if (!entry) return;
  if (entry.noAnswerTimer) {
    clearTimeout(entry.noAnswerTimer);
    entry.noAnswerTimer = null;
  }
  if (entry.disconnectTimer) {
    clearTimeout(entry.disconnectTimer);
    entry.disconnectTimer = null;
  }
}

// Marque [userId] comme « ringing ». [timer] (optionnel) est le handle du délai
// « pas de réponse » — attaché seulement à la cible.
function setRinging(userId, { callId = null, peerId = null, timer = null, isVideo = false } = {}) {
  if (userId == null) return;
  const prev = _states.get(userId);
  if (prev?.noAnswerTimer && prev.noAnswerTimer !== timer) {
    clearTimeout(prev.noAnswerTimer);
  }
  if (prev?.disconnectTimer) {
    clearTimeout(prev.disconnectTimer);
  }
  _states.set(userId, {
    status: 'ringing',
    callId: callId != null ? String(callId) : (prev?.callId ?? null),
    peerId: peerId != null ? peerId : (prev?.peerId ?? null),
    noAnswerTimer: timer,
    disconnectTimer: null,
    lastAnswer: prev?.lastAnswer ?? null,
    isVideo: isVideo != null ? !!isVideo : !!prev?.isVideo,
  });
}

function setInCall(userId, { callId = null, peerId = null, lastAnswer = undefined, isVideo = undefined } = {}) {
  if (userId == null) return;
  const prev = _states.get(userId);
  _clearTimers(prev);
  _states.set(userId, {
    status: 'in_call',
    callId: callId != null ? String(callId) : (prev?.callId ?? null),
    peerId: peerId != null ? peerId : (prev?.peerId ?? null),
    noAnswerTimer: null,
    disconnectTimer: null,
    lastAnswer: lastAnswer !== undefined ? lastAnswer : (prev?.lastAnswer ?? null),
    isVideo: isVideo !== undefined ? !!isVideo : !!prev?.isVideo,
  });
}

function clear(userId) {
  if (userId == null) return;
  const prev = _states.get(userId);
  _clearTimers(prev);
  _states.delete(userId);
}

function cancelDisconnectGrace(userId) {
  const entry = getEntry(userId);
  if (!entry?.disconnectTimer) return;
  clearTimeout(entry.disconnectTimer);
  entry.disconnectTimer = null;
}

function scheduleDisconnectGrace(userId, onExpire) {
  if (userId == null || typeof onExpire !== 'function') return;
  const entry = getEntry(userId);
  if (!entry || entry.status !== 'in_call') return;
  cancelDisconnectGrace(userId);
  entry.disconnectTimer = setTimeout(() => {
    entry.disconnectTimer = null;
    onExpire();
  }, DISCONNECT_GRACE_MS);
}

module.exports = {
  get,
  isBusy,
  getEntry,
  setRinging,
  setInCall,
  clear,
  cancelDisconnectGrace,
  scheduleDisconnectGrace,
  DISCONNECT_GRACE_MS,
};
