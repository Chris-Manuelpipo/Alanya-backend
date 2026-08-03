// Registre des sessions d'appel à trois (« Ajouter à l'appel » / transfert assisté).
//
// Un appel 1-à-1 ordinaire n'a PAS de session : il vit entièrement dans callState.
// Une session naît au premier `call_add_participant` et meurt quand l'ajout échoue
// (retour à l'appel 1-à-1 vierge) ou qu'il ne reste plus assez de monde.
//
// C'est ce qui donne sa sémantique au droit d'ajout, sans avoir à le stocker
// explicitement quand il est disponible :
//
//   pas de session          → droit DISPONIBLE
//   session addRight=locked → droit VERROUILLÉ  (un invité est en train de sonner)
//   session addRight=consumed → droit CONSOMMÉ  (définitif, l'invité est entré)
//
// Un échec d'invitation détruit la session, ce qui rend mécaniquement le droit aux
// deux participants — sans quoi un simple refus condamnerait l'appel à ne plus
// jamais pouvoir accueillir personne.
//
// Chaque session : { sessionId, originCallId, isVideo, createdAt, addRight,
//                    participants: Map<userId, { joinedAt }>,
//                    pending: { userId, byUserId, invitedAt, timer } | null }

// Trois participants au maximum : ce n'est pas un appel de groupe.
const MAX_SESSION_PARTICIPANTS = 3;

const _sessions = new Map(); // sessionId -> session
const _byUser = new Map();   // userId(Number) -> sessionId

let _seq = 0;

function _toInt(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
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
 * Ne vérifie QUE le droit : c'est à l'appelant de s'assurer par ailleurs que
 * l'utilisateur est bien en communication à deux.
 */
function hasAddRight(userId) {
  return getByUser(userId) === null;
}

/**
 * Ouvre une session et y place l'invité en attente, en une seule opération.
 *
 * Volontairement SYNCHRONE et sans le moindre await : c'est cette atomicité qui
 * arbitre deux appuis simultanés sur « Ajouter ». La boucle Node étant
 * mono-thread, le premier message traité pose le verrou et le second repart
 * bredouille. Poser le verrou après une requête base rouvrirait la course.
 *
 * @returns {object|null} la session créée, ou null si l'un des trois est déjà
 *                        engagé dans une session (course perdue).
 */
function openWithPending({
  originCallId = null,
  isVideo = false,
  participants = [],
  inviteeId,
  byUserId,
  timer = null,
} = {}) {
  const invitee = _toInt(inviteeId);
  const by = _toInt(byUserId);
  const members = participants.map(_toInt).filter((v) => v != null);

  if (invitee == null || by == null || members.length < 2) return null;
  if (members.includes(invitee)) return null;
  if (!members.includes(by)) return null;

  // Un seul ajout par appel, et personne ne peut être dans deux sessions.
  for (const uid of [...members, invitee]) {
    if (_byUser.has(uid)) return null;
  }

  const sessionId = _nextSessionId(originCallId);
  const now = Date.now();
  const session = {
    sessionId,
    originCallId: originCallId != null ? String(originCallId) : null,
    isVideo: !!isVideo,
    createdAt: now,
    addRight: 'locked',
    participants: new Map(members.map((uid) => [uid, { joinedAt: now }])),
    pending: { userId: invitee, byUserId: by, invitedAt: now, timer },
  };

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
 * L'invitation a échoué (refus, occupé, sans réponse, annulation).
 * Détruit la session : l'appel redevient un 1-à-1 vierge et le droit d'ajout
 * repasse DISPONIBLE pour les deux participants.
 *
 * @returns {number|null} l'identifiant de l'invité retiré.
 */
function abortPending(sessionId) {
  const session = _sessions.get(sessionId);
  if (!session?.pending) return null;
  const inviteeId = session.pending.userId;
  _clearPendingTimer(session);

  // addRight vaut forcément 'locked' ici : une session déjà consommée n'a plus
  // d'invité en attente. On détruit donc sans condition.
  destroy(sessionId);
  return inviteeId;
}

/**
 * L'invité accepte : il devient participant et le droit d'ajout est consommé
 * définitivement, y compris pour les départs à venir.
 *
 * @returns {object|null} la session mise à jour.
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
  return session;
}

/**
 * Retire un participant (départ volontaire, déconnexion définitive).
 *
 * La session survit tant qu'il reste au moins deux personnes : c'est ce qui
 * permet aux deux autres de continuer après le départ d'un tiers, tout en
 * gardant le droit d'ajout consommé.
 *
 * @returns {{remaining: number[], destroyed: boolean, wasPending: boolean}}
 */
function removeParticipant(sessionId, userId) {
  const session = _sessions.get(sessionId);
  const id = _toInt(userId);
  if (!session || id == null) {
    return { remaining: [], destroyed: false, wasPending: false };
  }

  // Celui qui part est l'invité qui sonnait encore : c'est un échec d'invitation.
  if (isPending(session, id)) {
    const remaining = participantIds(session);
    abortPending(sessionId);
    return { remaining, destroyed: true, wasPending: true };
  }

  session.participants.delete(id);
  _byUser.delete(id);

  // Il ne reste pas de quoi tenir une conversation : la session n'a plus d'objet.
  if (session.participants.size < 2) {
    const remaining = participantIds(session);
    destroy(sessionId);
    return { remaining, destroyed: true, wasPending: false };
  }

  return { remaining: participantIds(session), destroyed: false, wasPending: false };
}

function destroy(sessionId) {
  const session = _sessions.get(sessionId);
  if (!session) return;
  _clearPendingTimer(session);
  for (const uid of session.participants.keys()) _byUser.delete(uid);
  if (session.pending) _byUser.delete(session.pending.userId);
  _sessions.delete(sessionId);
}

/** Remise à zéro — tests uniquement. */
function _reset() {
  for (const session of _sessions.values()) _clearPendingTimer(session);
  _sessions.clear();
  _byUser.clear();
  _seq = 0;
}

module.exports = {
  MAX_SESSION_PARTICIPANTS,
  getByUser,
  get,
  participantIds,
  peersOf,
  isPending,
  hasAddRight,
  openWithPending,
  setPendingTimer,
  abortPending,
  promotePending,
  removeParticipant,
  destroy,
  _reset,
};
