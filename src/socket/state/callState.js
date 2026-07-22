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
//                   lastAnswer, isVideo, ringingSince }

const DISCONNECT_GRACE_MS = 45 * 1000;
// Marge au-delà du timer no-answer (45 s) pour purger un état « ringing » fantôme.
const STALE_RINGING_MS = 50 * 1000;

const _states = new Map(); // userId(Number) -> entry

function get(userId) {
  if (userId == null) return 'idle';
  return _states.get(userId)?.status ?? 'idle';
}

function _samePeer(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function isStaleRinging(entry) {
  if (!entry || entry.status !== 'ringing') return false;
  const since = entry.ringingSince ?? 0;
  if (!since) return false;
  return Date.now() - since > STALE_RINGING_MS;
}

function clearStaleRinging(userId, pendingCalls = null) {
  const entry = getEntry(userId);
  if (!entry || !isStaleRinging(entry)) return false;
  const peerId = entry.peerId;
  clear(userId);
  if (peerId != null) {
    const peerEntry = getEntry(peerId);
    if (peerEntry?.status === 'ringing' && _samePeer(peerEntry.peerId, userId)) {
      clear(peerId);
    }
    if (pendingCalls?.clear) {
      pendingCalls.clear(peerId);
    }
  }
  if (pendingCalls?.clear) {
    pendingCalls.clear(userId);
  }
  return true;
}

/**
 * true si [userId] ne peut pas recevoir/lancer un appel avec [remoteId].
 * - « Glare » : déjà en sonnerie avec CE correspondant → pas occupé.
 * - Sonnerie périmée → purge puis libre.
 */
function isBusyForNewCall(userId, remoteId, pendingCalls = null) {
  clearStaleRinging(userId, pendingCalls);
  const entry = getEntry(userId);
  if (!entry) return false;
  if (entry.status !== 'ringing' && entry.status !== 'in_call') return false;
  if (entry.status === 'ringing' && _samePeer(entry.peerId, remoteId)) {
    return false;
  }
  return true;
}

/** @deprecated Préférer isBusyForNewCall avec remoteId. */
function isBusy(userId) {
  const status = get(userId);
  return status === 'ringing' || status === 'in_call';
}

function getEntry(userId) {
  if (userId == null) return null;
  return _states.get(userId) ?? null;
}

function findExistingRingingPair(callerID, targetID) {
  const targetEntry = getEntry(targetID);
  if (
    targetEntry?.status === 'ringing' &&
    _samePeer(targetEntry.peerId, callerID)
  ) {
    return { callId: targetEntry.callId, calleeId: targetID, callerId: callerID };
  }
  const callerEntry = getEntry(callerID);
  if (
    callerEntry?.status === 'ringing' &&
    _samePeer(callerEntry.peerId, targetID)
  ) {
    return { callId: callerEntry.callId, calleeId: targetID, callerId: callerID };
  }
  return null;
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
    ringingSince: Date.now(),
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
    ringingSince: null,
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
  isBusyForNewCall,
  findExistingRingingPair,
  clearStaleRinging,
  getEntry,
  setRinging,
  setInCall,
  clear,
  cancelDisconnectGrace,
  scheduleDisconnectGrace,
  DISCONNECT_GRACE_MS,
  STALE_RINGING_MS,
};
