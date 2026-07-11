// Registre autoritaire de l'état d'appel 1-à-1, indexé par userId.
//
// Sert à répondre « occupé » (busy) immédiatement quand une cible est déjà en
// train de sonner ou en communication, et à nettoyer proprement les deux
// participants sur tous les états terminaux (réponse, refus, fin, timeout,
// déconnexion).
//
// Statuts possibles : 'idle' (implicite, absent de la map) | 'ringing' | 'in_call'
//
// Chaque entrée : { status, callId, peerId, noAnswerTimer }
//  - callId        : id de l'appel courant (String) — sert à valider les timeouts
//  - peerId        : userId de l'autre participant (Number) — sert au nettoyage croisé
//  - noAnswerTimer  : handle setTimeout du délai « pas de réponse » (côté cible)

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

// Marque [userId] comme « ringing ». [timer] (optionnel) est le handle du délai
// « pas de réponse » — attaché seulement à la cible.
function setRinging(userId, { callId = null, peerId = null, timer = null } = {}) {
  if (userId == null) return;
  const prev = _states.get(userId);
  if (prev?.noAnswerTimer && prev.noAnswerTimer !== timer) {
    clearTimeout(prev.noAnswerTimer);
  }
  _states.set(userId, {
    status: 'ringing',
    callId: callId != null ? String(callId) : null,
    peerId: peerId != null ? peerId : null,
    noAnswerTimer: timer,
  });
}

function setInCall(userId, { callId = null, peerId = null } = {}) {
  if (userId == null) return;
  const prev = _states.get(userId);
  if (prev?.noAnswerTimer) clearTimeout(prev.noAnswerTimer);
  _states.set(userId, {
    status: 'in_call',
    callId: callId != null ? String(callId) : (prev?.callId ?? null),
    peerId: peerId != null ? peerId : (prev?.peerId ?? null),
    noAnswerTimer: null,
  });
}

function clear(userId) {
  if (userId == null) return;
  const prev = _states.get(userId);
  if (prev?.noAnswerTimer) clearTimeout(prev.noAnswerTimer);
  _states.delete(userId);
}

module.exports = { get, isBusy, getEntry, setRinging, setInCall, clear };
