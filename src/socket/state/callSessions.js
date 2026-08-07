// Registre des sessions d'appel à trois (« Ajouter à l'appel » / transfert).
//
// Un appel 1-à-1 ordinaire n'a PAS de session : il vit entièrement dans callState.
// Une session naît au premier `call_add_participant` et meurt quand l'ajout échoue
// (retour à l'appel 1-à-1 vierge) ou qu'il ne reste plus assez de monde.
//
//   pas de session            → droit DISPONIBLE
//   session addRight=locked   → droit VERROUILLÉ  (un invité sonne)
//   session addRight=consumed → droit CONSOMMÉ    (définitif après entrée)
//
// mode vit AU NIVEAU SESSION :
//   mode=join     → transfer === null
//   mode=transfer → objet transfer obligatoire

const MAX_SESSION_PARTICIPANTS = 3;

const TRANSFER_READY_TIMEOUT_MS = 25 * 1000;
const TRANSFER_AUTO_LEAVE_MS = 10 * 1000;

const _sessions = new Map(); // sessionId -> session
const _byUser = new Map();   // userId(Number) -> sessionId

let _seq = 0;

function _toInt(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

function normalizeMode(mode) {
  return mode === 'transfer' ? 'transfer' : 'join';
}

function _nextSessionId(originCallId) {
  _seq += 1;
  return originCallId != null ? `conf_${originCallId}_${_seq}` : `conf_x_${_seq}`;
}

/** Session d'un utilisateur, qu'il y soit participant ou invité en attente. */
function getByUser(userId) {
  const id = _toInt(userId);
  if (id == null) return null;
  const sessionId = _byUser.get(id);
  if (!sessionId) return null;
  return _sessions.get(sessionId) ?? null;
}

function get(sessionId) {
  if (!sessionId) return null;
  return _sessions.get(sessionId) ?? null;
}

/** Identifiants des participants effectivement entrés (hors invité en attente). */
function participantIds(session) {
  if (!session) return [];
  return Array.from(session.participants.keys());
}

/** Les autres participants entrés, hors [userId]. */
function peersOf(session, userId) {
  const id = _toInt(userId);
  return participantIds(session).filter((p) => p !== id);
}

/** true si [userId] est l'invité qui sonne encore. */
function isPending(session, userId) {
  const id = _toInt(userId);
  return !!session?.pending && session.pending.userId === id;
}

/**
 * true si [userId] peut encore déclencher un ajout.
 * Ne vérifie QUE le droit : l'appelant doit s'assurer qu'il est bien à deux.
 */
function hasAddRight(userId) {
  return getByUser(userId) === null;
}

function clearTransferTimers(session) {
  if (!session?.transfer) return;
  if (session.transfer.readyTimer) {
    clearTimeout(session.transfer.readyTimer);
    session.transfer.readyTimer = null;
  }
  if (session.transfer.leaveTimer) {
    clearTimeout(session.transfer.leaveTimer);
    session.transfer.leaveTimer = null;
  }
}

/**
 * Ouvre une session et y place l'invité en attente, en une seule opération.
 * SYNCHRONE (avant tout await) pour arbitrer les courses.
 *
 * @returns {object|null}
 */
function openWithPending({
  originCallId = null,
  isVideo = false,
  participants = [],
  inviteeId,
  byUserId,
  timer = null,
  mode = 'join',
} = {}) {
  const invitee = _toInt(inviteeId);
  const by = _toInt(byUserId);
  const members = participants.map(_toInt).filter((v) => v != null);
  const normalizedMode = normalizeMode(mode);

  if (invitee == null || by == null || members.length < 2) return null;
  if (members.includes(invitee)) return null;
  if (!members.includes(by)) return null;

  for (const uid of [...members, invitee]) {
    if (_byUser.has(uid)) return null;
  }

  const sessionId = _nextSessionId(originCallId);
  const now = Date.now();
  const session = {
    sessionId,
    originCallId: originCallId != null ? String(originCallId) : null,
    isVideo: !!isVideo,
    mode: normalizedMode,
    createdAt: now,
    addRight: 'locked',
    participants: new Map(members.map((uid) => [uid, { joinedAt: now }])),
    pending: {
      userId: invitee,
      byUserId: by,
      invitedAt: now,
      timer,
      acceptedByDeviceId: null,
      acceptedSocketId: null,
    },
    transfer: null,
  };

  if (normalizedMode === 'transfer') {
    session.transfer = {
      initiatorId: by,
      targetId: invitee,
      state: 'pending',
      readyBy: new Set(),
      readyTimer: null,
      leaveTimer: null,
    };
  }

  _sessions.set(sessionId, session);
  for (const uid of members) _byUser.set(uid, sessionId);
  _byUser.set(invitee, sessionId);

  return session;
}

/** Remplace le timer d'expiration de l'invitation en cours. */
function setPendingTimer(sessionId, timer) {
  const session = _sessions.get(sessionId);
  if (!session?.pending) return;
  if (session.pending.timer && session.pending.timer !== timer) {
    clearTimeout(session.pending.timer);
  }
  session.pending.timer = timer;
}

function _clearPendingTimer(session) {
  if (session?.pending?.timer) {
    clearTimeout(session.pending.timer);
    session.pending.timer = null;
  }
}

/**
 * L'invitation a échoué. Détruit la session (droit d'ajout rendu).
 * @returns {number|null} invité retiré
 */
function abortPending(sessionId) {
  const session = _sessions.get(sessionId);
  if (!session?.pending) return null;
  const inviteeId = session.pending.userId;
  _clearPendingTimer(session);
  destroy(sessionId);
  return inviteeId;
}

/**
 * L'invité accepte : participant + addRight consommé.
 * En mode transfer → state joined (readyTimer armé par le handler).
 * @returns {object|null}
 */
function promotePending(sessionId) {
  const session = _sessions.get(sessionId);
  if (!session?.pending) return null;
  if (session.participants.size >= MAX_SESSION_PARTICIPANTS) return null;

  const inviteeId = session.pending.userId;
  _clearPendingTimer(session);
  session.participants.set(inviteeId, { joinedAt: Date.now() });
  session.pending = null;
  session.addRight = 'consumed';
  _byUser.set(inviteeId, sessionId);

  if (session.mode === 'transfer' && session.transfer) {
    session.transfer.state = 'joined';
    session.transfer.targetId = inviteeId;
  }

  return session;
}

/**
 * Après promotePending en transfer : marque joined et pose readyTimer.
 * Idempotent si déjà joined/armed.
 */
function markTransferJoined(sessionId, readyTimer) {
  const session = _sessions.get(sessionId);
  if (!session || session.mode !== 'transfer' || !session.transfer) return null;
  if (session.transfer.state === 'armed' || session.transfer.state === 'completed') {
    return session;
  }
  session.transfer.state = 'joined';
  if (session.transfer.readyTimer && session.transfer.readyTimer !== readyTimer) {
    clearTimeout(session.transfer.readyTimer);
  }
  session.transfer.readyTimer = readyTimer ?? null;
  return session;
}

/**
 * Enregistre un call_conf_ready. N'arme le leaveTimer qu'une seule fois.
 *
 * @returns {{ ok: boolean, armed: boolean, reason?: string, session?: object }}
 */
function registerTransferReady({ sessionId, reporterId, peerId, leaveTimerFactory }) {
  const session = _sessions.get(sessionId);
  if (!session || session.mode !== 'transfer' || !session.transfer) {
    return { ok: false, armed: false, reason: 'NO_TRANSFER' };
  }

  const t = session.transfer;
  if (t.state === 'armed' || t.state === 'completed' || t.state === 'cancelled') {
    return { ok: true, armed: false, reason: 'ALREADY_SETTLED', session };
  }
  if (t.state !== 'joined') {
    return { ok: false, armed: false, reason: 'NOT_JOINED' };
  }

  const reporter = _toInt(reporterId);
  const peer = _toInt(peerId);
  if (reporter == null || peer == null) {
    return { ok: false, armed: false, reason: 'INVALID' };
  }
  if (peer !== t.targetId) {
    return { ok: false, armed: false, reason: 'WRONG_PEER' };
  }
  if (reporter === t.initiatorId || reporter === t.targetId) {
    return { ok: false, armed: false, reason: 'INVALID_REPORTER' };
  }
  if (!session.participants.has(reporter) || !session.participants.has(peer)) {
    return { ok: false, armed: false, reason: 'NOT_MEMBER' };
  }

  t.readyBy.add(reporter);

  // Premier ready valide : armer une seule fois.
  if (!t.leaveTimer) {
    if (t.readyTimer) {
      clearTimeout(t.readyTimer);
      t.readyTimer = null;
    }
    t.state = 'armed';
    t.armedAt = Date.now();
    const leaveTimer = typeof leaveTimerFactory === 'function'
      ? leaveTimerFactory()
      : null;
    t.leaveTimer = leaveTimer;
    return { ok: true, armed: true, session };
  }

  return { ok: true, armed: false, reason: 'ALREADY_ARMED', session };
}

function armTransferLeaveTimer(sessionId, leaveTimer) {
  const session = _sessions.get(sessionId);
  if (!session?.transfer) return null;
  if (session.transfer.leaveTimer && session.transfer.leaveTimer !== leaveTimer) {
    clearTimeout(session.transfer.leaveTimer);
  }
  session.transfer.leaveTimer = leaveTimer;
  session.transfer.state = 'armed';
  session.transfer.armedAt = Date.now();
  return session;
}

/**
 * true ssi A+B+C présents : initiator, target, et au moins un tiers.
 */
function canCompleteTransfer(session) {
  if (!session || session.mode !== 'transfer' || !session.transfer) return false;
  const t = session.transfer;
  if (t.state !== 'armed') return false;
  const ids = participantIds(session);
  if (ids.length < 3) return false;
  if (!ids.includes(t.initiatorId)) return false;
  if (!ids.includes(t.targetId)) return false;
  return ids.some((id) => id !== t.initiatorId && id !== t.targetId);
}

function cancelTransfer(sessionId, reason = 'cancelled') {
  const session = _sessions.get(sessionId);
  if (!session?.transfer) return null;
  clearTransferTimers(session);
  session.transfer.state = 'cancelled';
  session.transfer.cancelReason = reason;
  return session;
}

function completeTransfer(sessionId) {
  const session = _sessions.get(sessionId);
  if (!session?.transfer) return null;
  clearTransferTimers(session);
  session.transfer.state = 'completed';
  return session;
}

/**
 * Retire un participant. Annule les timers de transfert.
 * @returns {{remaining: number[], destroyed: boolean, wasPending: boolean, hadPendingInvitee: number|null}}
 */
function removeParticipant(sessionId, userId) {
  const session = _sessions.get(sessionId);
  const id = _toInt(userId);
  if (!session || id == null) {
    return {
      remaining: [],
      destroyed: false,
      wasPending: false,
      hadPendingInvitee: null,
    };
  }

  const hadPendingInvitee = session.pending ? session.pending.userId : null;

  if (isPending(session, id)) {
    const remaining = participantIds(session);
    abortPending(sessionId);
    return {
      remaining,
      destroyed: true,
      wasPending: true,
      hadPendingInvitee: id,
    };
  }

  // Annuler le transfert si l'un des acteurs part (ou si B part pendant armed).
  if (session.transfer && session.transfer.state !== 'completed') {
    clearTransferTimers(session);
    if (session.transfer.state === 'armed' || session.transfer.state === 'joined') {
      session.transfer.state = 'cancelled';
    }
  }

  session.participants.delete(id);
  _byUser.delete(id);

  if (session.participants.size < 2) {
    // S'il reste un pending, destroy le nettoie aussi (interdit A + pending C).
    const remaining = participantIds(session);
    const pendingLeft = session.pending?.userId ?? null;
    destroy(sessionId);
    return {
      remaining,
      destroyed: true,
      wasPending: false,
      hadPendingInvitee: hadPendingInvitee ?? pendingLeft,
    };
  }

  return {
    remaining: participantIds(session),
    destroyed: false,
    wasPending: false,
    hadPendingInvitee: null,
  };
}

function destroy(sessionId) {
  const session = _sessions.get(sessionId);
  if (!session) return;
  _clearPendingTimer(session);
  clearTransferTimers(session);
  for (const uid of session.participants.keys()) _byUser.delete(uid);
  if (session.pending) _byUser.delete(session.pending.userId);
  _sessions.delete(sessionId);
}

/** Remise à zéro — tests uniquement. */
function _reset() {
  for (const session of _sessions.values()) {
    _clearPendingTimer(session);
    clearTransferTimers(session);
  }
  _sessions.clear();
  _byUser.clear();
  _seq = 0;
}

module.exports = {
  MAX_SESSION_PARTICIPANTS,
  TRANSFER_READY_TIMEOUT_MS,
  TRANSFER_AUTO_LEAVE_MS,
  getByUser,
  get,
  participantIds,
  peersOf,
  isPending,
  hasAddRight,
  normalizeMode,
  openWithPending,
  setPendingTimer,
  abortPending,
  promotePending,
  markTransferJoined,
  registerTransferReady,
  armTransferLeaveTimer,
  canCompleteTransfer,
  cancelTransfer,
  completeTransfer,
  clearTransferTimers,
  removeParticipant,
  destroy,
  _reset,
};
