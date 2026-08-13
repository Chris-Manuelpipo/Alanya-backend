const pool = require('../../config/db');
const { notifyIncomingCall, notifyGroupCall, notifyCallEnded } = require('../../services/notificationService');
const { maxParticipants, maxInvitees } = require('../../constants/participantLimits');
const { isBlockedEitherWay } = require('../../utils/blockUtils');
const { isOfficialAccount } = require('../../utils/officialAccountGuard');
const { getClientIp, parseCallMode } = require('../../utils/clientIp');
const { buildDirectConversationLookup } = require('../../utils/directConversation');
const pendingCalls = require('../state/pendingCalls');
const callState = require('../state/callState');
const callSessions = require('../state/callSessions');
const callDeviceOwnership = require('../state/callDeviceOwnership');
const {
  emitToUser,
  emitToDevice,
  emitToUserExceptDevice,
  isUserOnline,
  normalizeDeviceId,
} = require('../../utils/userSocketRegistry');

// ─────────────────────────────────────────────────────────────────────────────
// CONTRAT D'EVENTS — appels 1-à-1
//
// Client → Serveur :
//   call_user     { targetUserId, callerId, callerName, callerPhoto, isVideo, offer }
//   answer_call   { callerId, callId, answer }
//   reject_call   { callerId, callId? }
//   end_call      { targetUserId, mode? }
//   ice_candidate { targetUserId, candidate }
//   call_resume_ack    { callId }  — client confirme reprise après call_resume
//   call_resume_reject { callId, reason? } — client idle sans session locale
//
// Serveur → Client :
//   incoming_call { callId, callerId, callerName, callerPhoto, isVideo, offer }
//   call_answered { answer, callId? }
//   call_rejected { callId? }
//   call_ended    { callId?, reason?, claimedByAnotherDevice? }
//   call_error    { code, callId? }  — CALL_ANSWERED_ELSEWHERE, DEVICE_ID_REQUIRED…
//   call_failed   { reason, code? }                     — erreur (hors-ligne, données invalides…)
//                 code CALL_SELF : la cible est l'appelant lui-même.
//                 code CALL_ID_UNAVAILABLE : pas d'appel sans callId serveur.
//   call_busy     { callId, targetId, reason:'busy' }   — cible déjà ringing / in_call
//   call_resume   { callId, peerId, status, isVideo, role, answer? }
//
// Ownership média : callDeviceOwnership (par callId/sessionId/roomId + userId → device).
// Rooms signaling : user_<alanyaID>_device_<normalizedDeviceId> (jamais device_<id> global).
//   call_no_answer{ callId, targetId, reason:'no_answer' } — timeout serveur sans réponse
//   ice_candidate { candidate }
//
// État autoritaire par userId (callState) : idle | ringing | in_call.
//  - call_user  : cible occupée → call_busy (pas d'incoming_call ni FCM) ; sinon les
//                 deux participants passent « ringing » + timer no-answer (45 s).
//  - answer_call: les deux participants passent « in_call ».
//  - reject/end/timeout/disconnect : les deux repassent « idle ».
//  - auth:login in_call : call_resume + timeout ack (8 s) ; grâce disconnect conservée
//    jusqu'à call_resume_ack (ou call_rejoin implicite). Reject/timeout → endActiveCall.
//  - Tous les états terminaux émettent le FCM call_ended (avec callId) nécessaire pour
//    couper la sonnerie/CallKit du destinataire réveillé en arrière-plan.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// CONTRAT D'EVENTS — « Ajouter à l'appel » / transfert (3 participants max)
//
// Client → Serveur :
//   call_add_participant { targetUserId, mode?: 'join'|'transfer' }
//   call_add_cancel      { }
//   call_conf_join       { }
//   call_conf_reject     { }
//   call_conf_ready      { sessionId, peerId }  — participant restant ↔ C connected
//   end_call             { … }  — « je pars » si session
//
// Serveur → Client :
//   call_add_pending  { sessionId, callId, invitee, byUserId, mode }
//   call_conf_invite  { sessionId, callId, roomId, sessionKind, mode, from, peers, isVideo }
//   call_conf_joined  { sessionId, user, mode? }
//   call_conf_peers   { sessionId, peers, mode? }
//   call_conf_failed  { sessionId, userId, reason, mode? }
//   call_conf_left    { sessionId, userId, remaining, reason? }
//   call_transfer_armed { sessionId, leaveInMs }     — initiateur seulement
//   call_transfer_done  { sessionId, transferredUserId, remainingParticipantIds, reason }
//   call_add_rejected { code }
//
// mode absent → join. Timer 10 s après call_conf_ready uniquement (serveur).
// ─────────────────────────────────────────────────────────────────────────────

// Délai serveur avant de déclarer un appel « sans réponse » (marge > sonnerie CallKit 30 s).
const NO_ANSWER_MS = 45 * 1000;
const {
  TRANSFER_READY_TIMEOUT_MS,
  TRANSFER_AUTO_LEAVE_MS,
} = callSessions;

const groupRooms = new Map();

function toInt(v) {
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

function getRoomParticipants(room) {
  if (!room) return null;
  return room.participants ?? room;
}

// Récupère (ou crée) la conversation 1-à-1 entre deux utilisateurs.
// Renvoie null si les deux identifiants sont identiques : un appel ne peut pas
// être dirigé vers soi-même, et créer une conv « à soi » ici la ferait passer
// pour une conversation d'appel.
async function getOrCreateDirectConversation(userA, userB) {
  if (Number(userA) === Number(userB)) return null;

  const lookup = buildDirectConversationLookup({ meId: userA, peerId: userB });
  const [existing] = await pool.execute(lookup.sql, lookup.params);
  if (existing.length > 0) return existing[0].conversID;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute(
      'INSERT INTO conversation (isGroup, lastMessageAt) VALUES (0, NOW())'
    );
    const conversID = result.insertId;
    for (const id of [userA, userB]) {
      await conn.execute(
        'INSERT INTO conv_participants (conversID, alanyaID) VALUES (?, ?)',
        [conversID, id]
      );
    }
    await conn.commit();
    return conversID;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Appelée dès qu'un appel atteint un état terminal (terminé / refusé).
// Met à jour l'aperçu de la conversation (lastMessage...) et notifie
// LES DEUX participants (contrairement aux events existants qui ne
// notifient que le correspondant) avec les données finales de l'appel.
async function finalizeCallAndNotify(io, userSockets, callID) {
  if (!callID) return;
  try {
    const [rows] = await pool.execute(
      `SELECT c.*,
              u1.nom as caller_nom, u1.pseudo as caller_pseudo, u1.avatar_url as caller_avatar,
              u2.nom as receiver_nom, u2.pseudo as receiver_pseudo, u2.avatar_url as receiver_avatar
       FROM callHistory c
       JOIN users u1 ON c.idCaller   = u1.alanyaID
       JOIN users u2 ON c.idReceiver = u2.alanyaID
       WHERE c.IDcall = ?`,
      [callID]
    );
    if (!rows.length) return;
    const call = rows[0];
    const { idCaller, idReceiver } = call;

    const conversID = await getOrCreateDirectConversation(idCaller, idReceiver);

    // conversID null (auto-appel) : pas d'aperçu à mettre à jour, mais on
    // notifie quand même le journal d'appels.
    if (conversID != null) {
      const isVideo = call.type === 1;

      // ⚠ Ces valeurs étaient 5 et 6, annotées « réservés ». Elles ne l'étaient
      // pas : **5 = localisation** et **6 = message système**. Un appel vocal
      // terminé marquait donc la conversation comme portant une position, et un
      // appel vidéo comme portant un événement de groupe — deux types dont le
      // client sait qu'ils contiennent du JSON, et qu'il essaie de décoder.
      //
      // 20 et 21 : hors de portée des types de messages (0 à 9), pour qu'aucune
      // extension future du fil ne vienne les reprendre. Miroir de
      // `lib/core/utils/call_log_preview.dart` côté Talky.
      const lastMessageType = isVideo ? 21 : 20;

      // Chaîne de repli, en français. Le client la remplace par sa propre
      // traduction à partir du type : il n'a pas besoin de ce texte, seulement
      // d'un aperçu correct pour les surfaces qui ne savent pas le reconstruire.
      const preview = isVideo ? '📹 Appel vidéo' : '📞 Appel vocal';

      await pool.execute(
        `UPDATE conversation
         SET lastMessage = ?, lastMessageAt = NOW(),
             lastMessageSenderID = ?, lastMessageType = ?
         WHERE conversID = ?`,
        [preview, idCaller, lastMessageType, conversID]
      );
    }

    const payload = { conversationID: conversID, call };
    for (const uid of [idCaller, idReceiver]) {
      emitToUser(io, uid, 'call_log_updated', payload);
    }
  } catch (err) {
    console.warn('[finalizeCallAndNotify]', err.message);
  }
}

// Déclenché par le timer NO_ANSWER_MS : l'appel est resté « ringing » sans réponse.
// Nettoie l'état des deux participants, prévient l'appelant (call_no_answer) et
// coupe la sonnerie du destinataire (FCM call_ended).
async function onNoAnswer(io, userSockets, callID, callerID, targetID) {
  const entry = callState.getEntry(targetID);
  // Le timer peut avoir été neutralisé entre-temps (réponse/refus/nouvel appel).
  if (!entry || entry.status !== 'ringing' || String(entry.callId) !== String(callID)) {
    return;
  }

  console.log(`[Socket call_user] ⏰ Pas de réponse: callId=${callID} caller=${callerID} target=${targetID}`);

  pendingCalls.clear(targetID);
  callState.clear(targetID);
  callState.clear(callerID);

  if (callID) {
    try {
      // status 3 = appel manqué / sans réponse.
      await pool.execute('UPDATE callHistory SET status = 3 WHERE IDcall = ?', [callID]);
    } catch (dbErr) {
      console.warn('[Socket call_user] no-answer DB update failed:', dbErr.message);
    }
    finalizeCallAndNotify(io, userSockets, callID)
      .catch((err) => console.warn('[Socket call_user] no-answer finalize error:', err.message));
  }

  emitToUser(io, callerID, 'call_no_answer', {
    callId:   callID != null ? String(callID) : null,
    targetId: String(targetID),
    reason:   'no_answer',
  });

  // Coupe de façon DÉTERMINISTE la sonnerie/l'écran entrant d'une cible au premier
  // plan (socket ouvert) : le FCM ci-dessous ne couvre que l'arrière-plan et peut
  // être retardé/perdu sous Doze. call_ended est traité quel que soit le statut.
  emitToUser(io, targetID, 'call_ended', {
    callId: callID != null ? String(callID) : null,
    reason: 'no_answer',
  });

  // Coupe la sonnerie/CallKit du destinataire s'il a été réveillé en arrière-plan.
  notifyCallEnded(targetID, callerID, 'Appel manqué', callID, { reason: 'no_answer' })
    .catch((err) => console.warn('[Socket call_user] no-answer notifyCallEnded error:', err.message));

  if (callID != null) callDeviceOwnership.release(String(callID));
}

function createRoomState(isVideo, callerID, callerInfo) {
  const participants = new Map();
  if (callerID != null) {
    participants.set(callerID, callerInfo);
  }
  // ownerID : seul l'organisateur peut terminer l'appel pour tout le monde
  // (end_group_call). null si la room a été créée par un join tardif.
  return { isVideo: !!isVideo, participants, ownerID: callerID ?? null };
}

/**
 * Nettoyage à la déconnexion : retire l'utilisateur de sa room d'appel de
 * groupe. Sans lui, chaque crash/kill d'app en plein appel laissait une entrée
 * `groupRooms` immortelle (fuite mémoire) et un participant fantôme qui finit
 * par rendre la room « complète » — et les autres membres n'apprenaient jamais
 * le départ.
 */
function cleanupGroupRoomOnDisconnect(io, socket) {
  const rId = socket.currentGroupRoom;
  if (!rId) return;
  try {
    const room = groupRooms.get(rId);
    const participants = getRoomParticipants(room);
    if (participants && socket.alanyaID != null) {
      participants.delete(socket.alanyaID);
      if (participants.size === 0) groupRooms.delete(rId);
    }
    socket.to(`group_${rId}`).emit('group_user_left', {
      roomId: rId,
      userId: String(socket.alanyaID),
    });
  } catch (e) {
    console.warn('[Socket disconnect] group room cleanup failed:', e.message);
  } finally {
    socket.currentGroupRoom = null;
  }
}

/**
 * Clôt l'entrée callHistory d'un appel et rafraîchit l'aperçu de conversation.
 * Mutualisé entre la fin d'appel 1-à-1 et la fin d'une session à trois.
 */
async function closeCallHistory(io, userSockets, callID) {
  if (!callID) return;
  try {
    // status 3 = manqué / coupé sans réponse propre. La durée est recalculée
    // si start_time existe.
    await pool.execute(
      `UPDATE callHistory
       SET status = CASE WHEN status = 0 THEN 3 ELSE status END,
           duree = GREATEST(0, TIMESTAMPDIFF(SECOND, start_time, NOW()))
       WHERE IDcall = ?`,
      [callID],
    );
  } catch (dbErr) {
    console.warn('[Socket closeCallHistory] DB update failed:', dbErr.message);
  }
  finalizeCallAndNotify(io, userSockets, callID)
    .catch((err) => console.warn('[Socket closeCallHistory] finalize error:', err.message));
}

/**
 * Retire [userID] de sa session à trois, si tant est qu'il en ait une.
 *
 * C'est le cœur de « raccrocher = partir » : tant qu'il reste deux personnes,
 * l'appel continue sans celui qui s'en va, et les deux restants se retrouvent
 * face à face. Ce n'est qu'en tombant à une seule personne que l'appel se
 * termine réellement.
 *
 * Le cas de l'invité qui raccroche alors qu'il sonnait encore est traité comme
 * un refus : les deux présents retrouvent leur appel 1-à-1 et leur droit d'ajout.
 *
 * @returns {Promise<boolean>} true si le départ a été absorbé par la session —
 *          l'appelant ne doit alors PAS dérouler la fin d'appel 1-à-1.
 */
async function leaveCallSession(io, userSockets, userID, reason = 'leave') {
  const session = callSessions.getByUser(userID);
  if (!session) return false;

  const { sessionId, originCallId, mode } = session;
  const pendingInvitee = session.pending?.userId ?? null;
  const wasPending = callSessions.isPending(session, userID);
  const transferMeta = session.transfer
    ? {
        initiatorId: session.transfer.initiatorId,
        targetId: session.transfer.targetId,
        state: session.transfer.state,
      }
    : null;

  // Participant présent qui part alors qu'un invité sonne encore :
  // après son départ il ne resterait plus 2 présents → annuler l'invitation
  // AVANT removeParticipant, pour ne jamais laisser participants=[A] + pending=C.
  if (!wasPending && pendingInvitee != null) {
    const presentCount = callSessions.participantIds(session).length;
    if (presentCount <= 2) {
      failInvite(io, sessionId, reason === 'disconnect' ? 'offline' : 'caller_left');
      // Session détruite. On termine le départ comme un hangup 1-à-1.
      callState.cancelDisconnectGrace(userID);
      const entry = callState.getEntry(userID);
      const peerID = entry?.peerId != null ? toInt(entry.peerId) : null;
      const callID = entry?.callId ?? originCallId ?? null;
      callState.clear(userID);
      pendingCalls.clear(userID);

      if (peerID != null) {
        callState.cancelDisconnectGrace(peerID);
        callState.clear(peerID);
        pendingCalls.clear(peerID);
        emitToUser(io, peerID, 'call_ended', {
          callId: callID != null ? String(callID) : null,
        });
        notifyCallEnded(peerID, userID, 'Correspondant', callID)
          .catch((err) => console.warn('[Socket leaveCallSession] FCM error:', err.message));
        await closeCallHistory(io, userSockets, callID);
      }
      return true;
    }
  }

  // Auto-transfert : marquer completed AVANT remove pour ne pas confondre avec cancel.
  if (reason === 'transfer' && session.transfer) {
    callSessions.completeTransfer(sessionId);
  }

  const { remaining, hadPendingInvitee } = callSessions.removeParticipant(sessionId, userID);

  console.log(
    `[Socket] leaveCallSession user=${userID} session=${sessionId} ` +
    `pending=${wasPending} restants=[${remaining}] reason=${reason}`,
  );

  callState.cancelDisconnectGrace(userID);
  pendingCalls.clear(userID);

  // Si destroy a emporté un pending (ex. départ → <2 présents), couper CallKit C.
  if (!wasPending && hadPendingInvitee != null && !callSessions.get(sessionId)) {
    callState.clear(hadPendingInvitee);
    pendingCalls.clear(hadPendingInvitee);
    emitToUser(io, hadPendingInvitee, 'call_ended', { callId: sessionId });
    notifyCallEnded(hadPendingInvitee, userID, 'Correspondant', sessionId)
      .catch((err) => console.warn('[Socket leaveCallSession] FCM pending error:', err.message));
  }

  // L'invité s'en va avant d'être entré : simple échec d'invitation.
  if (wasPending) {
    callState.clear(userID);
    const failReason = reason === 'disconnect'
      ? 'offline'
      : (reason === 'media_not_ready' ? 'media_not_ready' : 'declined');
    for (const uid of remaining) {
      emitToUser(io, uid, 'call_conf_failed', {
        sessionId,
        userId: String(userID),
        reason: failReason,
        mode: mode || 'join',
      });
    }
    return true;
  }

  callState.clear(userID);

  try {
    await closeSessionHistoryFor(sessionId, userID);
  } catch (err) {
    console.warn('[Socket leaveCallSession] historique:', err.message);
  }

  // Transfert : notifier l'initiateur si départ manuel pendant armed.
  if (
    transferMeta &&
    transferMeta.state === 'armed' &&
    Number(userID) === Number(transferMeta.initiatorId) &&
    reason !== 'transfer'
  ) {
    emitToUser(io, userID, 'call_transfer_done', {
      sessionId,
      transferredUserId: String(userID),
      remainingParticipantIds: remaining.map(String),
      reason: 'manual',
    });
  }

  // Retrait serveur (média non prêt) : C doit fermer CallKit / UI.
  if (reason === 'media_not_ready') {
    emitToUser(io, userID, 'call_ended', { callId: sessionId });
    notifyCallEnded(userID, remaining[0] ?? null, 'Correspondant', sessionId)
      .catch((err) => console.warn('[Socket leaveCallSession] FCM media_not_ready:', err.message));
  }

  // Auto-transfert : FCM pour couper CallKit si l'app de l'initiateur est en BG/kill.
  // Pas de call_ended socket ici : call_transfer_done suffit en foreground, et un
  // call_ended socket risquait d'être mal interprété / doublé avec le leave.
  if (reason === 'transfer') {
    notifyCallEnded(userID, remaining[0] ?? null, 'Correspondant', sessionId)
      .catch((err) => console.warn('[Socket leaveCallSession] FCM transfer:', err.message));
  }

  if (remaining.length >= 2) {
    const [first, second] = remaining;
    callState.setPeer(first, second);
    callState.setPeer(second, first);

    const leftPayload = {
      sessionId,
      userId: String(userID),
      remaining: remaining.map(String),
      mode: mode || 'join',
    };
    if (reason === 'media_not_ready') leftPayload.reason = 'media_not_ready';
    if (reason === 'transfer') leftPayload.reason = 'transfer';

    for (const uid of remaining) {
      emitToUser(io, uid, 'call_conf_left', leftPayload);
    }
    return true;
  }

  if (remaining.length === 1) {
    const last = remaining[0];
    const lastEntry = callState.getEntry(last);
    const lastCallId = lastEntry?.callId ?? originCallId ?? null;

    callState.cancelDisconnectGrace(last);
    callState.clear(last);
    pendingCalls.clear(last);

    emitToUser(io, last, 'call_ended', {
      callId: lastCallId != null ? String(lastCallId) : null,
    });
    notifyCallEnded(last, userID, 'Correspondant', lastCallId)
      .catch((err) => console.warn('[Socket leaveCallSession] FCM error:', err.message));

    try {
      await closeSessionHistoryFor(sessionId, last);
    } catch (err) {
      console.warn('[Socket leaveCallSession] historique last:', err.message);
    }
    try {
      await closeCallHistory(io, userSockets, lastCallId);
    } catch (err) {
      console.warn('[Socket leaveCallSession] closeCallHistory:', err.message);
    }
  }

  return true;
}

/**
 * Termine l'appel 1-à-1 actif d'un utilisateur (disconnect / kill app).
 * Nettoie callState + pendingCalls, prévient le pair (socket + FCM call_ended).
 * @returns {Promise<boolean>} true si un appel a été terminé.
 */
async function endActiveCallForUser(io, userSockets, userID, reason = 'disconnect') {
  // Session à trois : le départ n'emporte pas l'appel des autres.
  if (await leaveCallSession(io, userSockets, userID, reason)) {
    return true;
  }

  callState.cancelDisconnectGrace(userID);
  const entry = callState.getEntry(userID);
  if (!entry || (entry.status !== 'ringing' && entry.status !== 'in_call')) {
    return false;
  }

  const peerID = entry.peerId != null ? toInt(entry.peerId) : null;
  const callID = entry.callId != null ? entry.callId : null;
  const callIdStr = callID != null ? String(callID) : null;

  console.log(
    `[Socket] endActiveCallForUser user=${userID} peer=${peerID} callId=${callIdStr ?? 'none'} reason=${reason}`,
  );

  pendingCalls.clear(userID);
  if (peerID) pendingCalls.clear(peerID);
  callState.cancelDisconnectGrace(userID);
  if (peerID) callState.cancelDisconnectGrace(peerID);
  callState.clear(userID);
  if (peerID) callState.clear(peerID);

  await closeCallHistory(io, userSockets, callID);

  if (peerID) {
    emitToUser(io, peerID, 'call_ended', { callId: callIdStr });
    notifyCallEnded(peerID, userID, 'Correspondant', callID)
      .catch((err) => console.warn('[Socket endActiveCallForUser] FCM error:', err.message));
  }

  return true;
}

// Récupère un état « occupé » fantôme : l'utilisateur est marqué ringing/in_call
// mais n'a PLUS AUCUN socket connecté et aucune reconnexion en grâce → son appel
// précédent n'a jamais été nettoyé (kill multi-socket, socket fantôme, crash sans
// end_call…). On le purge des deux côtés pour ne pas renvoyer un faux call_busy.
// Session à trois résiduelle : le participant n'a plus aucune socket et aucune
// reconnexion en grâce — son client a terminé sans prévenir (crash, kill, bug).
// Sans ce nettoyage, la session le maintiendrait « occupé » et confisquerait le
// droit d'ajout de l'appel indéfiniment.
function reclaimStaleSession(io, userID) {
  const session = callSessions.getByUser(userID);
  if (!session) return false;
  if (isUserOnline(io, userID)) return false;
  if (callState.getEntry(userID)?.disconnectTimer) return false;

  console.log(
    `[callSessions] reclaimStaleSession user=${userID} session=${session.sessionId} (hors-ligne, sans grâce)`,
  );
  callSessions.removeParticipant(session.sessionId, userID);
  return true;
}

function reclaimStaleBusy(io, userID) {
  reclaimStaleSession(io, userID);
  const entry = callState.getEntry(userID);
  if (!entry) return false;
  if (entry.status !== 'in_call' && entry.status !== 'ringing') return false;
  if (isUserOnline(io, userID)) return false;   // en ligne : appel en arrière-plan légitime
  if (entry.disconnectTimer) return false;       // grâce de reconnexion déjà armée
  const peerID = entry.peerId != null ? toInt(entry.peerId) : null;
  console.log(
    `[callState] reclaimStaleBusy user=${userID} status=${entry.status} (offline, sans grâce)`,
  );
  callState.clear(userID);
  pendingCalls.clear(userID);
  if (peerID) {
    const peerEntry = callState.getEntry(peerID);
    if (peerEntry && String(peerEntry.peerId) === String(userID)) {
      callState.clear(peerID);
      pendingCalls.clear(peerID);
    }
  }
  return true;
}

const callUser = (io, socket, userSockets) => {
  socket.on('call_user', async (data) => {
    try {
      if (!socket.authenticated) {
        console.warn('[Socket call_user] ** Tentative non authentifiée');
        return;
      }

      const { targetUserId, callerId, callerName, callerPhoto, isVideo, offer } = data;
      const targetID = toInt(targetUserId);
      const callerID = socket.alanyaID;
      const callerDeviceId = normalizeDeviceId(socket.deviceId);

      // Identité appelant = socket uniquement (jamais le payload client).
      if (callerId != null && toInt(callerId) != null && toInt(callerId) !== callerID) {
        console.warn(
          `[Socket call_user] ⛔ callerId spoof refusé payload=${callerId} socket=${callerID}`,
        );
        socket.emit('call_failed', {
          reason: 'Identité invalide',
          code: 'CALLER_ID_MISMATCH',
        });
        return;
      }

      console.log(`[Socket call_user] 📞 Appel: ${callerID} → ${targetID} (${isVideo ? 'vidéo' : 'audio'})`);

      if (!callerDeviceId) {
        socket.emit('call_failed', {
          reason: 'Identifiant appareil requis',
          code: 'DEVICE_ID_REQUIRED',
        });
        return;
      }

      if (!targetID || !offer) {
        console.warn('[Socket call_user] ** Données invalides', { targetID, offerExists: !!offer });
        socket.emit('call_failed', { reason: 'Données d\'appel invalides' });
        return;
      }

      // Auto-appel : à refuser avant isBlockedEitherWay, qui renvoie false pour
      // une paire identique et laisserait passer l'appel.
      if (targetID === callerID) {
        console.warn(`[Socket call_user] ** Auto-appel refusé: user=${callerID}`);
        socket.emit('call_failed', { reason: 'Appel impossible', code: 'CALL_SELF' });
        return;
      }

      // Le compte officiel diffuse, il ne décroche pas. Sans ce garde, l'appel
      // partirait vers un compte que personne n'ouvrira jamais.
      if (await isOfficialAccount(targetID)) {
        socket.emit('call_failed', {
          reason: 'Ce compte ne reçoit pas d\'appels',
          code: 'OFFICIAL_NOT_CALLABLE',
        });
        return;
      }

      if (await isBlockedEitherWay(callerID, targetID)) {
        socket.emit('call_failed', { reason: 'Appel impossible', code: 'CALL_BLOCKED' });
        return;
      }

      // État autoritaire : cible déjà en sonnerie avec quelqu'un d'autre ou en communication.
      const existingPair = callState.findExistingRingingPair(callerID, targetID);
      if (existingPair) {
        console.log(
          `[Socket call_user] 🔁 Paire déjà en sonnerie callId=${existingPair.callId ?? 'none'} caller=${callerID} target=${targetID}`,
        );
        const pending = pendingCalls.get(targetID);
        if (pending && isUserOnline(io, targetID)) {
          emitToUser(io, targetID, 'incoming_call', pending);
        }
        // Glare : l'appelant est aussi la cible de l'autre sonnerie → lui renvoyer l'entrant.
        const pendingForCaller = pendingCalls.get(callerID);
        if (pendingForCaller && isUserOnline(io, callerID)) {
          emitToUser(io, callerID, 'incoming_call', pendingForCaller);
        }
        return;
      }

      // Purge un éventuel « occupé » fantôme (appel précédent jamais nettoyé)
      // avant d'évaluer la disponibilité réelle des deux participants.
      reclaimStaleBusy(io, targetID);
      reclaimStaleBusy(io, callerID);

      if (callState.isBusyForNewCall(callerID, targetID, pendingCalls)) {
        console.log(`[Socket call_user] ⛔ Appelant occupé: caller=${callerID} (${callState.get(callerID)})`);
        socket.emit('call_failed', {
          reason: 'Un appel est déjà en cours de votre côté',
          code: 'CALLER_BUSY',
        });
        return;
      }

      if (callState.isBusyForNewCall(targetID, callerID, pendingCalls)) {
        console.log(`[Socket call_user] ⛔ Cible occupée: target=${targetID} (${callState.get(targetID)})`);
        socket.emit('call_busy', {
          callId:   null,
          targetId: String(targetID),
          reason:   'busy',
        });
        return;
      }

      let callID = null;
      try {
        const callerIp = getClientIp(socket);
        const [result] = await pool.execute(
          `INSERT INTO callHistory (idCaller, idReceiver, type, status, created_at, start_time, ip)
           VALUES (?, ?, ?, 0, NOW(), NOW(), ?)`,
          [callerID, targetID, isVideo ? 1 : 0, callerIp]
        );
        callID = result.insertId;
        socket.currentCallID = callID;
        socket.currentCallTarget = targetID;
      } catch (dbErr) {
        console.warn('[Socket call_user] DB insert failed:', dbErr.message);
      }

      if (!callID) {
        socket.emit('call_failed', {
          reason: 'Impossible de démarrer l\'appel',
          code: 'CALL_ID_UNAVAILABLE',
        });
        return;
      }

      const callKey = String(callID);
      callDeviceOwnership.setCalling(callKey, callerID, {
        activeDeviceId: callerDeviceId,
        activeSocketId: socket.id,
      });
      callDeviceOwnership.ring(callKey, targetID);

      const incomingPayload = {
        callId:      callKey,
        callerId:    String(callerID),
        callerName:  callerName  || '',
        callerPhoto: callerPhoto || null,
        isVideo:     isVideo     || false,
        offer,
      };

      // Bufferise l'appel : si le destinataire est hors-ligne (app fermée), il sera
      // réveillé par FCM puis l'event `incoming_call` lui sera rejoué à sa reconnexion.
      pendingCalls.set(targetID, incomingPayload);
      console.log(`[PhantomCallFix] pending:set target=${targetID} callId=${incomingPayload.callId ?? 'none'}`);

      if (isUserOnline(io, targetID)) {
        console.log(`[Socket call_user] !! Envoi incoming_call à user_${targetID}`);
        emitToUser(io, targetID, 'incoming_call', incomingPayload);
        const delivery = pendingCalls.markDelivered(targetID, 'socket-live');
        if (delivery) {
          console.log(
            `[PhantomCallFix] pending:delivered-live target=${targetID} callId=${delivery.callId ?? 'none'} attempts=${delivery.attempts}`,
          );
        }
      } else {
        console.warn(`[Socket call_user] ** Utilisateur ${targetID} non trouvé en socket — fallback FCM + rejeu à la reconnexion`);
      }

      // Marque les deux participants « ringing » et arme le timeout côté cible.
      const noAnswerTimer = setTimeout(
        () => onNoAnswer(io, userSockets, callID, callerID, targetID),
        NO_ANSWER_MS,
      );
      callState.setRinging(targetID, { callId: callID, peerId: callerID, timer: noAnswerTimer, isVideo: !!isVideo });
      callState.setRinging(callerID, { callId: callID, peerId: targetID, isVideo: !!isVideo });

      notifyIncomingCall(targetID, callerID, callerName, callerPhoto, isVideo, callID)
        .catch((err) => console.warn('[Socket call_user] FCM error:', err.message));
    } catch (error) {
      console.error('[Socket call_user]', error.message);
      socket.emit('call_failed', { reason: error.message });
    }
  });
};

const answerCall = (io, socket, userSockets) => {
  socket.on('answer_call', async (data) => {
    try {
      if (!socket.authenticated) {
        console.warn('[Socket answer_call] ** Non authentifié');
        return;
      }
      const { callerId, answer, callId: rawCallId } = data || {};

      const callerID   = toInt(callerId);
      const receiverID = socket.alanyaID;
      const deviceId   = normalizeDeviceId(socket.deviceId);
      if (!callerID || !answer) {
        console.warn('[Socket answer_call] ** Données invalides', { callerID, answerExists: !!answer });
        return;
      }
      if (!deviceId) {
        socket.emit('call_error', { code: 'DEVICE_ID_REQUIRED' });
        return;
      }

      const callId = toInt(rawCallId);
      if (!callId) {
        socket.emit('call_error', { code: 'CALL_ID_REQUIRED' });
        return;
      }
      const callKey = String(callId);

      const receiverEntry = callState.getEntry(receiverID);
      const callerEntry = callState.getEntry(callerID);
      const pairOk =
        receiverEntry &&
        receiverEntry.status === 'ringing' &&
        String(receiverEntry.peerId) === String(callerID) &&
        String(receiverEntry.callId) === callKey &&
        callerEntry &&
        callerEntry.status === 'ringing' &&
        String(callerEntry.peerId) === String(receiverID) &&
        String(callerEntry.callId) === callKey;

      if (!pairOk) {
        socket.emit('call_error', {
          code: 'CALL_NOT_RINGING',
          callId: callKey,
        });
        return;
      }

      const claim = callDeviceOwnership.tryClaim(
        callKey,
        receiverID,
        deviceId,
        socket.id,
      );
      if (!claim.ok) {
        const code = claim.reason === 'DEVICE_ID_REQUIRED'
          ? 'DEVICE_ID_REQUIRED'
          : (claim.reason === 'NO_SESSION' ? 'CALL_INVALID_STATE' : 'CALL_ANSWERED_ELSEWHERE');
        socket.emit('call_error', { code, callId: callKey });
        return;
      }

      console.log(`[Socket answer_call] 📞 Réponse: Receiver ${receiverID} device=${deviceId} → Caller ${callerID} callId=${callKey}`);

      pendingCalls.clear(receiverID);

      const isVideo = !!callerEntry?.isVideo;
      callState.setInCall(receiverID, { callId, peerId: callerID, isVideo });
      callState.setInCall(callerID, { callId, peerId: receiverID, lastAnswer: answer, isVideo });

      socket.currentCallID = callId;
      socket.currentCallTarget = callerID;

      const elsewherePayload = {
        callId: callKey,
        reason: 'answered_elsewhere',
        claimedByAnotherDevice: true,
      };
      emitToUserExceptDevice(
        io,
        receiverID,
        deviceId,
        'call_ended',
        elsewherePayload,
      );
      notifyCallEnded(receiverID, callerID, 'Appel répondu sur un autre appareil', callId, {
        excludeDeviceId: deviceId,
        reason: 'answered_elsewhere',
        claimedByAnotherDevice: true,
      }).catch((err) => console.warn('[Socket answer_call] FCM siblings:', err.message));

      try {
        const [result] = await pool.execute(
          `UPDATE callHistory
           SET start_time = NOW(), status = 1
           WHERE IDcall = ?`,
          [callId],
        );
        console.log(`[Socket answer_call] !! DB updated: ${result.affectedRows} row(s)`);
      } catch (dbErr) {
        console.warn('[Socket answer_call] DB update failed:', dbErr.message);
      }

      const callerDeviceId = callDeviceOwnership.getActiveDeviceId(callKey, callerID);
      const answeredPayload = {
        answer,
        callId: callKey,
      };
      if (!callerDeviceId) {
        console.warn(`[Socket answer_call] ** pas de device caller actif — pas de fan-out call_answered`);
        return;
      }
      console.log(`[Socket answer_call] !! Envoi call_answered → deviceRoom(${callerID}, ${callerDeviceId})`);
      emitToDevice(io, callerID, callerDeviceId, 'call_answered', answeredPayload);
    } catch (error) {
      console.error('[Socket answer_call]', error.message);
    }
  });
};

const rejectCall = (io, socket, userSockets) => {
  socket.on('reject_call', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { callerId, callId } = data || {};
      const callerID   = toInt(callerId);
      const receiverID = socket.alanyaID;
      if (!callerID) return;

      await processRejectCall({
        io,
        userSockets,
        callerID,
        receiverID,
        callIdHint: callId,
        rejectingDeviceId: normalizeDeviceId(socket.deviceId),
      });
    } catch (error) {
      console.error('[Socket reject_call]', error.message);
    }
  });
};

/**
 * Logique partagée socket + HTTP : refuse un appel entrant pour [receiverID].
 * Idempotent (double refus / course HTTP+socket → no-op sûr).
 */
async function processRejectCall({
  io,
  userSockets,
  callerID,
  receiverID,
  callIdHint = null,
  rejectingDeviceId = null,
}) {
  if (!callerID || !receiverID) {
    return { ok: false, reason: 'invalid_ids' };
  }

  const hintID = toInt(callIdHint);
  if (hintID) {
    const receiverEntry = callState.getEntry(toInt(receiverID));
    const currentPairCallID =
      receiverEntry && String(receiverEntry.peerId) === String(callerID)
        ? toInt(receiverEntry.callId)
        : null;
    if (currentPairCallID && currentPairCallID !== hintID) {
      try {
        await pool.execute(
          'UPDATE callHistory SET status = 2 WHERE IDcall = ? AND status = 0',
          [hintID],
        );
      } catch (dbErr) {
        console.warn('[processRejectCall] stale DB update failed:', dbErr.message);
      }
      console.log(
        `[processRejectCall] refus tardif ignoré: hint=${hintID} ≠ courant=${currentPairCallID} (receiver=${receiverID})`,
      );
      return { ok: true, callId: hintID, stale: true };
    }
  }

  let rejectedCallID = toInt(callIdHint);
  if (!rejectedCallID) {
    rejectedCallID = callState.getEntry(receiverID)?.callId ?? null;
  }
  const callKey = rejectedCallID != null ? String(rejectedCallID) : null;
  if (callKey) {
    const owner = callDeviceOwnership.getEntry(callKey, receiverID);
    if (owner?.state === 'active' && owner.activeDeviceId) {
      const rejDid = normalizeDeviceId(rejectingDeviceId);
      if (!rejDid || owner.activeDeviceId !== rejDid) {
        console.log(
          `[processRejectCall] refus ignoré (déjà claimé device=${owner.activeDeviceId})`,
        );
        return { ok: false, reason: 'already_answered', callId: rejectedCallID };
      }
    }
  }

  pendingCalls.clear(receiverID);
  callState.clear(receiverID);
  callState.clear(callerID);
  if (callKey) callDeviceOwnership.release(callKey);

  try {
    if (!rejectedCallID) {
      const [rows] = await pool.execute(
        `SELECT IDcall FROM callHistory
         WHERE idCaller = ? AND idReceiver = ?
         ORDER BY created_at DESC LIMIT 1`,
        [callerID, receiverID]
      );
      rejectedCallID = rows[0]?.IDcall ?? null;
    }
    if (rejectedCallID) {
      await pool.execute('UPDATE callHistory SET status = 2 WHERE IDcall = ?', [rejectedCallID]);
    }
  } catch (dbErr) {
    console.warn('[processRejectCall] DB update failed:', dbErr.message);
  }

  finalizeCallAndNotify(io, userSockets, rejectedCallID)
    .catch((err) => console.warn('[processRejectCall] finalizeCallAndNotify error:', err.message));

  const rejectedCallIdStr = rejectedCallID != null ? String(rejectedCallID) : null;
  emitToUser(io, callerID, 'call_rejected', { callId: rejectedCallIdStr });

  notifyCallEnded(callerID, receiverID, 'Destinataire', rejectedCallID, {
    reason: 'rejected_elsewhere',
  }).catch((err) => console.warn('[processRejectCall] FCM notifyCallEnded error:', err.message));

  const siblingPayload = {
    callId: rejectedCallIdStr,
    reason: 'rejected_elsewhere',
    claimedByAnotherDevice: true,
  };
  if (rejectingDeviceId) {
    emitToUserExceptDevice(io, receiverID, rejectingDeviceId, 'call_ended', siblingPayload);
    notifyCallEnded(receiverID, callerID, 'Appel refusé sur un autre appareil', rejectedCallID, {
      excludeDeviceId: rejectingDeviceId,
      reason: 'rejected_elsewhere',
      claimedByAnotherDevice: true,
    }).catch((err) => console.warn('[processRejectCall] FCM siblings:', err.message));
  } else {
    emitToUser(io, receiverID, 'call_ended', siblingPayload);
  }

  console.log(`[processRejectCall] !! Refus receiver=${receiverID} → caller=${callerID} callId=${rejectedCallIdStr}`);
  return { ok: true, callId: rejectedCallID };
}

const iceCandidate = (io, socket, userSockets) => {
  socket.on('ice_candidate', (data) => {
    try {
      if (!socket.authenticated) return;
      const { targetUserId, candidate } = data;
      const targetID = toInt(targetUserId);
      if (!targetID || !candidate) return;

      const selfId = socket.alanyaID;
      const deviceId = normalizeDeviceId(socket.deviceId);
      const selfEntry = callState.getEntry(selfId);
      const callKey = selfEntry?.callId != null ? String(selfEntry.callId) : null;
      if (!callKey || !deviceId || !callDeviceOwnership.isOwnerDevice(callKey, selfId, deviceId)) {
        return;
      }
      // Signal média = preuve de session locale (clients sans call_resume_ack).
      if (selfEntry.resumeAckTimer) {
        callState.confirmResume(selfId);
      }
      const targetDeviceId = callDeviceOwnership.getActiveDeviceId(callKey, targetID);
      if (!targetDeviceId) {
        console.warn(`[Socket ice_candidate] pas de device cible user=${targetID} — drop`);
        return;
      }
      emitToDevice(io, targetID, targetDeviceId, 'ice_candidate', {
        candidate,
        ...(data?.generation != null ? { generation: data.generation } : {}),
        ...(data?.callId != null ? { callId: data.callId } : {}),
      });
    } catch (error) {
      console.error('[Socket ice_candidate]', error.message);
    }
  });
};

const endCall = (io, socket, userSockets) => {
  socket.on('end_call', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { targetUserId, mode: rawMode } = data;
      const targetID = toInt(targetUserId);
      const callerID = socket.alanyaID;
      const mode = parseCallMode(rawMode);

      // Session à trois : raccrocher ne fait que retirer celui qui appuie.
      // L'appel des autres continue — d'où la sortie anticipée, avant toute
      // clôture d'historique ou notification de fin.
      if (await leaveCallSession(io, userSockets, callerID, 'hangup')) {
        socket.currentCallID     = null;
        socket.currentCallTarget = null;
        return;
      }

      // Déjà hors appel (ex. 2ᵉ end_call CallKit après leaveCallSession) :
      // ne pas retomber en teardown 1-à-1 vers targetUserId — sinon on envoie
      // call_ended à l'inviteur alors que les deux restants continuent.
      const selfStillActive = callState.getEntry(callerID);
      if (
        !selfStillActive ||
        (selfStillActive.status !== 'ringing' && selfStillActive.status !== 'in_call')
      ) {
        socket.currentCallID     = null;
        socket.currentCallTarget = null;
        return;
      }

      // Préférer le callId d'état (fiable) avant clear — évite un FCM call_ended
      // sans callId qui ne pourrait pas bloquer un FCM `call` tardif.
      const selfEntry = selfStillActive;
      const peerEntry = targetID ? callState.getEntry(targetID) : null;
      let endedCallID =
        (selfEntry?.callId != null ? selfEntry.callId : null) ??
        (peerEntry?.callId != null ? peerEntry.callId : null) ??
        socket.currentCallID ??
        null;

      // Appel terminé/annulé : ne pas le rejouer au destinataire.
      if (targetID) pendingCalls.clear(targetID);
      pendingCalls.clear(callerID);

      // État autoritaire : les deux participants repassent « idle ».
      callState.clear(callerID);
      if (targetID) callState.clear(targetID);
      if (endedCallID != null) callDeviceOwnership.release(String(endedCallID));

      if (callerID && endedCallID == null) {
        try {
          const [rows] = await pool.execute(
            `SELECT IDcall FROM callHistory
             WHERE (idCaller = ? OR idReceiver = ?)
               AND (idCaller = ? OR idReceiver = ?)
             ORDER BY created_at DESC LIMIT 1`,
            [callerID, callerID, targetID || callerID, targetID || callerID]
          );
          endedCallID = rows[0]?.IDcall ?? null;
        } catch (dbErr) {
          console.warn('[Socket end_call] DB lookup failed:', dbErr.message);
        }
      }

      if (endedCallID) {
        try {
          await pool.execute(
            `UPDATE callHistory
             SET duree = GREATEST(0, TIMESTAMPDIFF(SECOND, start_time, NOW())),
                 mode = COALESCE(?, mode)
             WHERE IDcall = ?`,
            [mode, endedCallID]
          );
        } catch (dbErr) {
          console.warn('[Socket end_call] DB update failed:', dbErr.message);
        }
      }

      // Met à jour la conversation + notifie les deux côtés (discussions + logs d'appel).
      finalizeCallAndNotify(io, userSockets, endedCallID)
        .catch((err) => console.warn('[Socket end_call] finalizeCallAndNotify error:', err.message));

      if (targetID) {
        const endedCallIdStr = endedCallID != null ? String(endedCallID) : null;
        emitToUser(io, targetID, 'call_ended', {
          callId: endedCallIdStr,
          reason: 'caller_ended',
        });

        // Envoyer FCM au receiver pour arrêter la sonnerie (cas où receiver est en background)
        notifyCallEnded(targetID, callerID, 'L\'appelant', endedCallID, {
          reason: 'caller_ended',
        })
          .catch((err) => console.warn('[Socket end_call] FCM notifyCallEnded error:', err.message));
      }

      socket.currentCallID     = null;
      socket.currentCallTarget = null;
    } catch (error) {
      console.error('[Socket end_call]', error.message);
    }
  });
};

//  AJOUT D'UN PARTICIPANT — « Ajouter à l'appel » (transfert assisté)

/** Fiches d'affichage (nom, photo) d'un lot d'utilisateurs, indexées par id. */
async function fetchUserCards(userIds = []) {
  const ids = [...new Set(userIds.map(toInt).filter((v) => v != null))];
  if (!ids.length) return new Map();
  try {
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await pool.execute(
      `SELECT alanyaID, nom, pseudo, avatar_url FROM users WHERE alanyaID IN (${placeholders})`,
      ids,
    );
    return new Map(rows.map((r) => [
      r.alanyaID,
      {
        id: String(r.alanyaID),
        name: (r.nom || '').trim() || r.pseudo || '',
        photo: r.avatar_url || null,
      },
    ]));
  } catch (dbErr) {
    console.warn('[Socket call_add] fetchUserCards failed:', dbErr.message);
    return new Map();
  }
}

/**
 * Ouvre les lignes d'historique de l'invité, une par paire réellement connectée.
 *
 * callHistory reste binaire : l'appel à trois s'y écrit comme un faisceau de
 * paires reliées par un même sessionID. L'appel d'origine est rattaché à la
 * session au passage, pour que le journal puisse regrouper les trois lignes.
 */
async function openSessionHistory(session, inviteeID) {
  const { sessionId, originCallId, isVideo } = session;
  const present = callSessions.participantIds(session).filter((id) => id !== inviteeID);
  try {
    if (originCallId) {
      await pool.execute('UPDATE callHistory SET sessionID = ? WHERE IDcall = ?', [
        sessionId,
        originCallId,
      ]);
    }
    for (const uid of present) {
      // status 1 = décroché : l'invité est effectivement entré.
      await pool.execute(
        `INSERT INTO callHistory (idCaller, idReceiver, type, status, created_at, start_time, sessionID)
         VALUES (?, ?, ?, 1, NOW(), NOW(), ?)`,
        [uid, inviteeID, isVideo ? 1 : 0, sessionId],
      );
    }
  } catch (dbErr) {
    console.warn('[Socket call_add] openSessionHistory failed:', dbErr.message);
  }
}

/**
 * Clôt les lignes de session d'un participant qui s'en va.
 *
 * Seules les siennes : les deux autres continuent de parler et leur propre ligne
 * doit rester ouverte jusqu'à ce qu'ils raccrochent à leur tour.
 */
async function closeSessionHistoryFor(sessionId, userID) {
  if (!sessionId || !userID) return;
  try {
    await pool.execute(
      `UPDATE callHistory
       SET duree = GREATEST(0, TIMESTAMPDIFF(SECOND, start_time, NOW()))
       WHERE sessionID = ? AND (idCaller = ? OR idReceiver = ?) AND duree = 0`,
      [sessionId, userID, userID],
    );
  } catch (dbErr) {
    console.warn('[Socket call_add] closeSessionHistoryFor failed:', dbErr.message);
  }
}

function failInvite(io, sessionId, reason, { decliningDeviceId = null } = {}) {
  const session = callSessions.get(sessionId);
  if (!session?.pending) return;

  const inviteeID = session.pending.userId;
  const present = callSessions.participantIds(session);
  const mode = session.mode || 'join';

  console.log(`[Socket call_add] ✖ invitation soldée session=${sessionId} invité=${inviteeID} raison=${reason}`);

  callSessions.abortPending(sessionId);
  callState.clear(inviteeID);
  pendingCalls.clear(inviteeID);
  callDeviceOwnership.release(sessionId);

  for (const uid of present) {
    emitToUser(io, uid, 'call_conf_failed', {
      sessionId,
      userId: String(inviteeID),
      reason,
      mode,
    });
  }

  // Toujours stopper les appareils de C (y compris declined) — ExceptDevice si connu.
  const endedPayload = {
    callId: sessionId,
    reason: reason === 'declined' ? 'rejected_elsewhere' : 'cancelled',
    claimedByAnotherDevice: reason === 'declined',
  };
  if (decliningDeviceId) {
    emitToUserExceptDevice(io, inviteeID, decliningDeviceId, 'call_ended', endedPayload);
    notifyCallEnded(inviteeID, present[0] ?? null, 'Correspondant', sessionId, {
      excludeDeviceId: decliningDeviceId,
      reason: endedPayload.reason,
      claimedByAnotherDevice: !!endedPayload.claimedByAnotherDevice,
    }).catch((err) => console.warn('[Socket call_add] FCM call_ended error:', err.message));
  } else {
    emitToUser(io, inviteeID, 'call_ended', endedPayload);
    notifyCallEnded(inviteeID, present[0] ?? null, 'Correspondant', sessionId, {
      reason: endedPayload.reason,
    }).catch((err) => console.warn('[Socket call_add] FCM call_ended error:', err.message));
  }
}

/**
 * Timeout média : C n'a jamais eu de lien WebRTC ready → retirer C, garder A/B.
 */
async function onTransferMediaNotReady(io, userSockets, sessionId) {
  const session = callSessions.get(sessionId);
  if (!session || session.mode !== 'transfer' || !session.transfer) return;
  if (session.transfer.state !== 'joined') return;

  const targetId = session.transfer.targetId;
  console.log(`[Socket transfer] ⏱ media_not_ready session=${sessionId} target=${targetId}`);
  callSessions.cancelTransfer(sessionId, 'media_not_ready');
  await leaveCallSession(io, userSockets, targetId, 'media_not_ready');
}

/**
 * Auto-leave de l'initiateur après 10 s si canCompleteTransfer.
 */
async function onTransferAutoLeave(io, userSockets, sessionId) {
  const session = callSessions.get(sessionId);
  if (!session || session.mode !== 'transfer' || !session.transfer) return;
  if (session.transfer.state !== 'armed') return;

  if (!callSessions.canCompleteTransfer(session)) {
    console.log(`[Socket transfer] ⛔ auto-leave annulé (canCompleteTransfer=false) session=${sessionId}`);
    callSessions.cancelTransfer(sessionId, 'incomplete');
    return;
  }

  const initiatorId = session.transfer.initiatorId;
  const remainingBefore = callSessions.participantIds(session)
    .filter((id) => id !== initiatorId);

  console.log(`[Socket transfer] ⏱ auto-leave initiator=${initiatorId} session=${sessionId}`);
  await leaveCallSession(io, userSockets, initiatorId, 'transfer');

  emitToUser(io, initiatorId, 'call_transfer_done', {
    sessionId,
    transferredUserId: String(initiatorId),
    remainingParticipantIds: remainingBefore.map(String),
    reason: 'automatic',
  });
}

const addParticipant = (io, socket, userSockets) => {
  socket.on('call_add_participant', async (data) => {
    try {
      if (!socket.authenticated) return;

      const { targetUserId, callerName, callerPhoto, mode: rawMode } = data || {};
      const inviteeID   = toInt(targetUserId);
      const requesterID = socket.alanyaID;
      const mode = callSessions.normalizeMode(rawMode);

      const reject = (code) => socket.emit('call_add_rejected', { code });

      if (!inviteeID || !requesterID) return reject('INVALID');
      if (inviteeID === requesterID) return reject('TARGET_SELF');

      const entry = callState.getEntry(requesterID);
      if (!entry || entry.status !== 'in_call' || entry.peerId == null) {
        return reject('NOT_IN_CALL');
      }
      const peerID = toInt(entry.peerId);
      if (!peerID) return reject('NOT_IN_CALL');
      if (peerID === inviteeID) return reject('TARGET_ALREADY_IN_CALL');

      reclaimStaleBusy(io, inviteeID);
      if (callState.isBusyForNewCall(inviteeID, requesterID, pendingCalls)) {
        console.log(`[Socket call_add] ⛔ invité occupé: ${inviteeID} (${callState.get(inviteeID)})`);
        return reject('TARGET_BUSY');
      }

      const session = callSessions.openWithPending({
        originCallId: entry.callId ?? null,
        isVideo: !!entry.isVideo,
        participants: [requesterID, peerID],
        inviteeId: inviteeID,
        byUserId: requesterID,
        mode,
      });
      if (!session) {
        console.log(`[Socket call_add] ⛔ droit déjà utilisé: demandeur=${requesterID}`);
        return reject('ADD_ALREADY_USED');
      }
      const { sessionId } = session;

      // Ownership session : A/B depuis l'appel d'origine, C en ringing.
      callDeviceOwnership.ring(sessionId, inviteeID);
      if (entry.callId != null) {
        for (const uid of [requesterID, peerID]) {
          const prev = callDeviceOwnership.getEntry(String(entry.callId), uid);
          if (prev?.activeDeviceId) {
            callDeviceOwnership.setCalling(sessionId, uid, {
              activeDeviceId: prev.activeDeviceId,
              activeSocketId: prev.activeSocketId,
            });
            const e = callDeviceOwnership.getEntry(sessionId, uid);
            if (e) e.state = 'active';
          }
        }
      }

      const [blockedByRequester, blockedByPeer] = await Promise.all([
        isBlockedEitherWay(requesterID, inviteeID),
        isBlockedEitherWay(peerID, inviteeID),
      ]);
      if (blockedByRequester || blockedByPeer) {
        console.log(`[Socket call_add] ⛔ blocage: invité=${inviteeID}`);
        callSessions.abortPending(sessionId);
        return reject('TARGET_BLOCKED');
      }

      callState.setRinging(inviteeID, {
        callId: sessionId,
        peerId: requesterID,
        isVideo: !!entry.isVideo,
      });

      callSessions.setPendingTimer(
        sessionId,
        setTimeout(() => failInvite(io, sessionId, 'no_answer'), NO_ANSWER_MS),
      );

      const cards = await fetchUserCards([requesterID, peerID, inviteeID]);
      const fallback = (uid) => ({ id: String(uid), name: '', photo: null });
      const inviteeCard   = cards.get(inviteeID)   ?? fallback(inviteeID);
      const requesterCard = cards.get(requesterID) ?? fallback(requesterID);
      const peerCard      = cards.get(peerID)      ?? fallback(peerID);

      if (callerName) requesterCard.name = callerName;
      if (callerPhoto) requesterCard.photo = callerPhoto;

      console.log(
        `[Socket call_add] ➕ ${requesterID} ajoute ${inviteeID} mode=${mode} ` +
        `à l'appel avec ${peerID} (session=${sessionId})`,
      );

      for (const uid of [requesterID, peerID]) {
        emitToUser(io, uid, 'call_add_pending', {
          sessionId,
          callId: session.originCallId,
          invitee: inviteeCard,
          byUserId: String(requesterID),
          mode,
        });
      }

      emitToUser(io, inviteeID, 'call_conf_invite', {
        sessionId,
        callId: session.originCallId,
        roomId: sessionId,
        sessionKind: 'conference',
        mode,
        from: requesterCard,
        peers: [requesterCard, peerCard],
        isVideo: !!entry.isVideo,
      });

      notifyIncomingCall(
        inviteeID,
        requesterID,
        requesterCard.name,
        requesterCard.photo,
        !!entry.isVideo,
        sessionId,
        {
          roomId: sessionId,
          sessionId,
          sessionKind: 'conference',
          mode,
        },
      ).catch((err) => console.warn('[Socket call_add] FCM invite error:', err.message));
    } catch (error) {
      console.error('[Socket call_add_participant]', error.message);
      socket.emit('call_add_rejected', { code: 'INTERNAL' });
    }
  });
};

const cancelAddParticipant = (io, socket, userSockets) => {
  socket.on('call_add_cancel', () => {
    try {
      if (!socket.authenticated) return;
      const session = callSessions.getByUser(socket.alanyaID);
      if (!session?.pending) return;
      // L'invitation appartient à celui qui l'a lancée : lui seul l'annule.
      if (session.pending.byUserId !== socket.alanyaID) return;
      failInvite(io, session.sessionId, 'cancelled');
    } catch (error) {
      console.error('[Socket call_add_cancel]', error.message);
    }
  });
};

const confReject = (io, socket, userSockets) => {
  socket.on('call_conf_reject', () => {
    try {
      if (!socket.authenticated) return;
      const session = callSessions.getByUser(socket.alanyaID);
      if (!session || !callSessions.isPending(session, socket.alanyaID)) return;
      failInvite(io, session.sessionId, 'declined', {
        decliningDeviceId: normalizeDeviceId(socket.deviceId),
      });
    } catch (error) {
      console.error('[Socket call_conf_reject]', error.message);
    }
  });
};

const confJoin = (io, socket, userSockets) => {
  socket.on('call_conf_join', async () => {
    try {
      if (!socket.authenticated) return;
      const inviteeID = socket.alanyaID;
      const deviceId = normalizeDeviceId(socket.deviceId);
      if (!deviceId) {
        socket.emit('call_error', { code: 'DEVICE_ID_REQUIRED' });
        return;
      }

      const session = callSessions.getByUser(inviteeID);
      if (!session || !callSessions.isPending(session, inviteeID)) return;

      const { sessionId } = session;
      if (session.pending.acceptedByDeviceId) {
        socket.emit('call_error', {
          code: 'CALL_ALREADY_JOINED_ON_OTHER_DEVICE',
          callId: sessionId,
        });
        return;
      }

      if (!callDeviceOwnership.getEntry(sessionId, inviteeID)) {
        callDeviceOwnership.ring(sessionId, inviteeID);
      }
      const claim = callDeviceOwnership.tryClaim(
        sessionId,
        inviteeID,
        deviceId,
        socket.id,
      );
      if (!claim.ok) {
        socket.emit('call_error', {
          code: claim.reason === 'CALL_ANSWERED_ELSEWHERE'
            ? 'CALL_ALREADY_JOINED_ON_OTHER_DEVICE'
            : 'CALL_INVALID_STATE',
          callId: sessionId,
        });
        return;
      }

      session.pending.acceptedByDeviceId = deviceId;
      session.pending.acceptedSocketId = socket.id;

      const mode = session.mode || 'join';
      const present = callSessions.participantIds(session);
      const promoted = callSessions.promotePending(sessionId);
      if (!promoted) return;

      // Ownership A/B : reprise depuis originCallId si pas encore migrés à l'invite.
      if (session.originCallId) {
        for (const uid of present) {
          if (callDeviceOwnership.getActiveDeviceId(sessionId, uid)) continue;
          const prev = callDeviceOwnership.getEntry(String(session.originCallId), uid);
          if (prev?.activeDeviceId) {
            callDeviceOwnership.setCalling(sessionId, uid, {
              activeDeviceId: prev.activeDeviceId,
              activeSocketId: prev.activeSocketId,
            });
            const e = callDeviceOwnership.getEntry(sessionId, uid);
            if (e) e.state = 'active';
          }
        }
      }

      pendingCalls.clear(inviteeID);
      callState.setInCall(inviteeID, {
        callId: sessionId,
        peerId: present[0] ?? null,
        isVideo: session.isVideo,
      });
      socket.currentCallID = sessionId;

      console.log(`[Socket call_add] ✔ ${inviteeID} device=${deviceId} rejoint session=${sessionId} mode=${mode}`);

      const elsewherePayload = {
        callId: sessionId,
        reason: 'answered_elsewhere',
        claimedByAnotherDevice: true,
      };
      emitToUserExceptDevice(io, inviteeID, deviceId, 'call_ended', elsewherePayload);
      notifyCallEnded(inviteeID, present[0] ?? null, 'Appel répondu sur un autre appareil', sessionId, {
        excludeDeviceId: deviceId,
        reason: 'answered_elsewhere',
        claimedByAnotherDevice: true,
      }).catch((err) => console.warn('[Socket call_conf_join] FCM siblings:', err.message));

      if (mode === 'transfer') {
        callSessions.markTransferJoined(
          sessionId,
          setTimeout(
            () => {
              onTransferMediaNotReady(io, userSockets, sessionId)
                .catch((err) => console.warn('[Socket transfer] media_not_ready error:', err.message));
            },
            TRANSFER_READY_TIMEOUT_MS,
          ),
        );
      }

      openSessionHistory(promoted, inviteeID)
        .catch((err) => console.warn('[Socket call_conf_join] historique:', err.message));

      const cards = await fetchUserCards([...present, inviteeID]);
      const fallback = (uid) => ({ id: String(uid), name: '', photo: null });
      const inviteeCard = cards.get(inviteeID) ?? fallback(inviteeID);

      for (const uid of present) {
        const activeDid = callDeviceOwnership.getActiveDeviceId(sessionId, uid);
        const payload = { sessionId, user: inviteeCard, mode };
        if (!activeDid) {
          console.warn(`[Socket call_conf_join] pas de device actif user=${uid} — drop conf_joined`);
          continue;
        }
        emitToDevice(io, uid, activeDid, 'call_conf_joined', payload);
      }

      emitToDevice(io, inviteeID, deviceId, 'call_conf_peers', {
        sessionId,
        isVideo: session.isVideo,
        mode,
        peers: present.map((uid) => cards.get(uid) ?? fallback(uid)),
      });
    } catch (error) {
      console.error('[Socket call_conf_join]', error.message);
    }
  });
};

const confReady = (io, socket, userSockets) => {
  socket.on('call_conf_ready', (data) => {
    try {
      if (!socket.authenticated) return;
      const reporterID = socket.alanyaID;
      const sessionId = data?.sessionId?.toString();
      const peerId = toInt(data?.peerId);
      if (!sessionId || !peerId) return;

      const deviceId = normalizeDeviceId(socket.deviceId);
      if (!deviceId || !callDeviceOwnership.isOwnerDevice(sessionId, reporterID, deviceId)) {
        console.log(
          `[Socket call_conf_ready] ignored reporter=${reporterID} reason=not_owner_device`,
        );
        return;
      }

      const result = callSessions.registerTransferReady({
        sessionId,
        reporterId: reporterID,
        peerId,
        leaveTimerFactory: () => setTimeout(
          () => {
            onTransferAutoLeave(io, userSockets, sessionId)
              .catch((err) => console.warn('[Socket transfer] auto-leave error:', err.message));
          },
          TRANSFER_AUTO_LEAVE_MS,
        ),
      });

      if (!result.ok) {
        console.log(`[Socket call_conf_ready] ignored reporter=${reporterID} reason=${result.reason}`);
        return;
      }

      if (result.armed) {
        const initiatorId = result.session.transfer.initiatorId;
        console.log(
          `[Socket call_conf_ready] ✔ armed session=${sessionId} ` +
          `reporter=${reporterID} peer=${peerId} → leave ${initiatorId} in ${TRANSFER_AUTO_LEAVE_MS}ms`,
        );
        const initDid = callDeviceOwnership.getActiveDeviceId(sessionId, initiatorId);
        const armedPayload = {
          sessionId,
          leaveInMs: TRANSFER_AUTO_LEAVE_MS,
        };
        if (initDid) {
          emitToDevice(io, initiatorId, initDid, 'call_transfer_armed', armedPayload);
        } else {
          console.warn(
            `[Socket call_conf_ready] pas de device initiateur=${initiatorId} — drop transfer_armed`,
          );
        }
      }
    } catch (error) {
      console.error('[Socket call_conf_ready]', error.message);
    }
  });
};

//  APPELS DE GROUPE

const createGroupCall = (io, socket, userSockets) => {
  socket.on('create_group_call', (data) => {
    try {
      if (!socket.authenticated) return;
      const { roomId, callerId, callerName, callerPhoto, isVideo, targetUserIds } = data;
      if (!roomId || !Array.isArray(targetUserIds)) return;

      const callerID = socket.alanyaID;
      const videoCall = !!isVideo;
      const callerDeviceId = normalizeDeviceId(socket.deviceId);
      if (!callerDeviceId) {
        return socket.emit('call_error', { code: 'DEVICE_ID_REQUIRED' });
      }
      if (callerId != null && toInt(callerId) != null && toInt(callerId) !== callerID) {
        console.warn(`[Socket create_group_call] callerId spoof payload=${callerId} socket=${callerID}`);
        return socket.emit('call_error', { code: 'CALLER_ID_MISMATCH' });
      }
      const inviteLimit = maxInvitees(videoCall);
      const uniqueTargets = [...new Set(
        targetUserIds.map(toInt).filter((id) => id && id !== callerID),
      )];

      if (uniqueTargets.length > inviteLimit) {
        return socket.emit('error', {
          message: `Maximum ${maxParticipants(videoCall)} participants en ${videoCall ? 'vidéo' : 'audio'} (vous inclus)`,
          code: 'GROUP_CALL_TOO_MANY',
        });
      }

      groupRooms.set(
        roomId,
        createRoomState(videoCall, callerID, {
          userName: callerName || '',
          userPhoto: callerPhoto || null,
        }),
      );

      socket.join(`group_${roomId}`);
      socket.currentGroupRoom = roomId;
      callDeviceOwnership.setCalling(String(roomId), callerID, {
        activeDeviceId: callerDeviceId,
        activeSocketId: socket.id,
      });
      const callerOwn = callDeviceOwnership.getEntry(String(roomId), callerID);
      if (callerOwn) callerOwn.state = 'active';

      const fcmTargets = [];
      for (const targetID of uniqueTargets) {
        callDeviceOwnership.ring(String(roomId), targetID);
        fcmTargets.push(targetID);
        if (isUserOnline(io, targetID)) {
          emitToUser(io, targetID, 'group_call_invite', {
            callerId:    String(callerID),
            callerName:  callerName  || '',
            callerPhoto: callerPhoto || null,
            isVideo:     videoCall,
            roomId,
          });
        }
      }

      // FCM en parallèle pour les destinataires hors-ligne / app fermée
      notifyGroupCall(fcmTargets, callerID, callerName, callerPhoto, videoCall, roomId)
        .catch((err) => console.warn('[Socket create_group_call] FCM error:', err.message));
    } catch (error) {
      console.error('[Socket create_group_call]', error.message);
    }
  });
};

const joinGroupCall = (io, socket, userSockets) => {
  socket.on('join_group_call', (data) => {
    try {
      if (!socket.authenticated) return;
      const { roomId, userId, userName, userPhoto } = data;
      if (!roomId) return;

      const userID = socket.alanyaID;
      if (userId != null && toInt(userId) != null && toInt(userId) !== userID) {
        console.warn(`[Socket join_group_call] userId spoof payload=${userId} socket=${userID}`);
        return socket.emit('call_error', { code: 'USER_ID_MISMATCH' });
      }
      const deviceId = normalizeDeviceId(socket.deviceId);
      if (!deviceId) {
        return socket.emit('call_error', { code: 'DEVICE_ID_REQUIRED' });
      }

      const roomKey = String(roomId);
      // Inviteé sans entrée ownership (join tardif) : ring serveur puis claim.
      if (!callDeviceOwnership.getEntry(roomKey, userID)) {
        callDeviceOwnership.ring(roomKey, userID);
      }
      const claim = callDeviceOwnership.tryClaim(roomKey, userID, deviceId, socket.id);
      if (!claim.ok) {
        return socket.emit('call_error', {
          code: claim.reason === 'CALL_ANSWERED_ELSEWHERE'
            ? 'CALL_ANSWERED_ELSEWHERE'
            : 'CALL_INVALID_STATE',
          callId: roomKey,
        });
      }

      let room = groupRooms.get(roomId);
      if (!room || !(room.participants instanceof Map)) {
        room = createRoomState(false, null, null);
        groupRooms.set(roomId, room);
      }

      const participants = getRoomParticipants(room);
      const limit = maxParticipants(room.isVideo);
      if (!participants.has(userID) && participants.size >= limit) {
        return socket.emit('error', {
          message: `Cet appel ${room.isVideo ? 'vidéo' : 'audio'} est complet (${limit} participants max)`,
          code: 'GROUP_CALL_FULL',
        });
      }

      participants.set(userID, { userName: userName || '', userPhoto: userPhoto || null });

      socket.join(`group_${roomId}`);
      socket.currentGroupRoom = roomId;

      if (!claim.alreadyOwner) {
        emitToUserExceptDevice(io, userID, deviceId, 'call_ended', {
          callId: roomKey,
          reason: 'answered_elsewhere',
          claimedByAnotherDevice: true,
        });
        notifyCallEnded(userID, null, 'Appel répondu sur un autre appareil', roomKey, {
          excludeDeviceId: deviceId,
          reason: 'answered_elsewhere',
          claimedByAnotherDevice: true,
        }).catch(() => {});
      }

      socket.to(`group_${roomId}`).emit('group_user_joined', {
        roomId,
        userId:    String(userID),
        userName:  userName  || '',
        userPhoto: userPhoto || null,
      });

      const participantIds = Array.from(participants.keys()).map(String);
      socket.emit('group_participants', { roomId, participants: participantIds });
    } catch (error) {
      console.error('[Socket join_group_call]', error.message);
    }
  });
};

const leaveGroupCall = (io, socket, userSockets) => {
  socket.on('leave_group_call', (data) => {
    try {
      if (!socket.authenticated) return;
      const { roomId } = data || {};
      const room = roomId ? groupRooms.get(roomId) : null;
      const participants = getRoomParticipants(room);

      if (participants && socket.alanyaID) {
        participants.delete(socket.alanyaID);
        if (participants.size === 0) groupRooms.delete(roomId);
      }

      const rId = roomId || socket.currentGroupRoom;
      if (rId) {
        socket.to(`group_${rId}`).emit('group_user_left', {
          roomId: rId,
          userId: String(socket.alanyaID),
        });
        socket.leave(`group_${rId}`);
      }

      socket.currentGroupRoom = null;
    } catch (error) {
      console.error('[Socket leave_group_call]', error.message);
    }
  });
};

const endGroupCall = (io, socket, userSockets) => {
  socket.on('end_group_call', (data) => {
    try {
      // Terminer l'appel pour TOUT le monde est réservé à l'organisateur
      // (ou, si la room n'a pas d'organisateur connu, à un participant).
      // Sans ces gardes, n'importe quelle socket — même non authentifiée —
      // pouvait tuer un appel de groupe en devinant son roomId.
      if (!socket.authenticated) return;
      const { roomId } = data || {};
      const rId = roomId || socket.currentGroupRoom;
      if (!rId) return;

      const room = groupRooms.get(rId);
      if (room) {
        const isOwner =
          room.ownerID != null && Number(room.ownerID) === Number(socket.alanyaID);
        const isParticipant = !!getRoomParticipants(room)?.has(socket.alanyaID);
        if (!isOwner && !(room.ownerID == null && isParticipant)) return;
      }

      groupRooms.delete(rId);
      io.to(`group_${rId}`).emit('group_call_ended', {});

      const roomSockets = io.sockets.adapter.rooms.get(`group_${rId}`);
      if (roomSockets) {
        for (const sid of roomSockets) {
          const s = io.sockets.sockets.get(sid);
          if (s) {
            s.leave(`group_${rId}`);
            s.currentGroupRoom = null;
          }
        }
      }
    } catch (error) {
      console.error('[Socket end_group_call]', error.message);
    }
  });
};

const groupOffer = (io, socket, userSockets) => {
  socket.on('group_offer', (data) => {
    try {
      if (!socket.authenticated) return;
      const { toUserId, offer, roomId } = data;
      const targetID = toInt(toUserId);
      if (!targetID || !offer) return;
      const rId = roomId != null ? String(roomId) : (socket.currentGroupRoom != null ? String(socket.currentGroupRoom) : null);
      const deviceId = normalizeDeviceId(socket.deviceId);
      if (!rId || !deviceId || !callDeviceOwnership.isOwnerDevice(rId, socket.alanyaID, deviceId)) {
        return;
      }
      const targetDid = callDeviceOwnership.getActiveDeviceId(rId, targetID);
      if (!targetDid) {
        console.warn(`[Socket group_offer] pas de device cible user=${targetID} — drop`);
        return;
      }
      emitToDevice(io, targetID, targetDid, 'group_offer', {
        fromUserId: String(socket.alanyaID),
        offer,
        roomId: rId,
        ...(data?.generation != null ? { generation: data.generation } : {}),
      });
    } catch (error) {
      console.error('[Socket group_offer]', error.message);
    }
  });
};

const groupAnswer = (io, socket, userSockets) => {
  socket.on('group_answer', (data) => {
    try {
      if (!socket.authenticated) return;
      const { toUserId, answer, roomId } = data;
      const targetID = toInt(toUserId);
      if (!targetID || !answer) return;
      const rId = roomId != null ? String(roomId) : (socket.currentGroupRoom != null ? String(socket.currentGroupRoom) : null);
      const deviceId = normalizeDeviceId(socket.deviceId);
      if (!rId || !deviceId || !callDeviceOwnership.isOwnerDevice(rId, socket.alanyaID, deviceId)) {
        return;
      }
      const targetDid = callDeviceOwnership.getActiveDeviceId(rId, targetID);
      if (!targetDid) {
        console.warn(`[Socket group_answer] pas de device cible user=${targetID} — drop`);
        return;
      }
      emitToDevice(io, targetID, targetDid, 'group_answer', {
        fromUserId: String(socket.alanyaID),
        answer,
        roomId: rId,
        ...(data?.generation != null ? { generation: data.generation } : {}),
      });
    } catch (error) {
      console.error('[Socket group_answer]', error.message);
    }
  });
};

const groupIceCandidate = (io, socket, userSockets) => {
  socket.on('group_ice_candidate', (data) => {
    try {
      if (!socket.authenticated) return;
      const { toUserId, candidate, roomId } = data;
      const targetID = toInt(toUserId);
      if (!targetID || !candidate) return;
      const rId = roomId != null ? String(roomId) : (socket.currentGroupRoom != null ? String(socket.currentGroupRoom) : null);
      const deviceId = normalizeDeviceId(socket.deviceId);
      if (!rId || !deviceId || !callDeviceOwnership.isOwnerDevice(rId, socket.alanyaID, deviceId)) {
        return;
      }
      const targetDid = callDeviceOwnership.getActiveDeviceId(rId, targetID);
      if (!targetDid) {
        console.warn(`[Socket group_ice_candidate] pas de device cible user=${targetID} — drop`);
        return;
      }
      emitToDevice(io, targetID, targetDid, 'group_ice_candidate', {
        fromUserId: String(socket.alanyaID),
        candidate,
        roomId: rId,
        ...(data?.generation != null ? { generation: data.generation } : {}),
      });
    } catch (error) {
      console.error('[Socket group_ice_candidate]', error.message);
    }
  });
};

//  ÉTAT MICRO (MUTE) 

// Appel 1-à-1 : relaie l'état micro vers le destinataire.
// Le userId est estampillé côté serveur (socket.alanyaID) : source fiable,
// impossible à usurper par le payload client.
const callMuteState = (io, socket, userSockets) => {
  socket.on('call:mute_state', (data) => {
    try {
      if (!socket.authenticated) return;
      const { toUserId, isMuted } = data || {};
      const targetID = toInt(toUserId);
      if (!targetID) return;

      emitToUser(io, targetID, 'call:mute_state', {
        userId:  String(socket.alanyaID),
        isMuted: !!isMuted,
      });
    } catch (error) {
      console.error('[Socket call:mute_state]', error.message);
    }
  });
};

// Appel de groupe : diffuse l'état micro à tous les autres participants.
// Les groupes classiques sont dans la room Socket.IO `group_<roomId>`. Une
// conférence créée par « Ajouter un participant » utilise au contraire une
// callSession et un routage média par appareil ; ses participants ne rejoignent
// pas cette room. On relaie donc cette session vers les seuls appareils owners,
// sans changer le chemin historique des groupes classiques.
const groupMuteState = (io, socket, userSockets) => {
  socket.on('group:mute_state', (data) => {
    try {
      if (!socket.authenticated) return;
      const rId = (data && data.roomId) || socket.currentGroupRoom;
      if (!rId) return;

      const payload = {
        roomId: String(rId),
        userId: String(socket.alanyaID),
        isMuted: !!(data && data.isMuted),
      };

      const session = callSessions.getByUser(socket.alanyaID);
      if (session && String(session.sessionId) === String(rId)) {
        for (const participantId of callSessions.participantIds(session)) {
          if (Number(participantId) === Number(socket.alanyaID)) continue;
          const deviceId = callDeviceOwnership.getActiveDeviceId(
            session.sessionId,
            participantId,
          );
          if (deviceId) {
            emitToDevice(io, participantId, deviceId, 'group:mute_state', payload);
          }
        }
        return;
      }

      socket.to(`group_${rId}`).emit('group:mute_state', payload);
    } catch (error) {
      console.error('[Socket group:mute_state]', error.message);
    }
  });
};

// Appel 1-à-1 : relaie l'état caméra vers le destinataire.
const callVideoState = (io, socket, userSockets) => {
  socket.on('call:video_state', (data) => {
    try {
      if (!socket.authenticated) return;
      const { toUserId, isVideoOn } = data || {};
      const targetID = toInt(toUserId);
      if (!targetID) return;

      emitToUser(io, targetID, 'call:video_state', {
        userId:    String(socket.alanyaID),
        isVideoOn: !!isVideoOn,
      });
    } catch (error) {
      console.error('[Socket call:video_state]', error.message);
    }
  });
};

// Appel de groupe : diffuse l'état caméra à tous les autres participants.
const groupVideoState = (io, socket, userSockets) => {
  socket.on('group:video_state', (data) => {
    try {
      if (!socket.authenticated) return;
      const rId = (data && data.roomId) || socket.currentGroupRoom;
      if (!rId) return;

      socket.to(`group_${rId}`).emit('group:video_state', {
        roomId:    rId,
        userId:    String(socket.alanyaID),
        isVideoOn: !!(data && data.isVideoOn),
      });
    } catch (error) {
      console.error('[Socket group:video_state]', error.message);
    }
  });
};

// Renégociation WebRTC après reconnexion (kill app en appel connecté).
/**
 * Émet call_resume UNIQUEMENT vers le device owner.
 * Auth ne doit plus appeler cancelDisconnectGrace pour un in_call.
 * Pas d'owner → pas d'emitToUser de secours ; timer RESUME_OWNER_MISSING dédié.
 */
function offerCallResume(io, socket, userSockets, userID) {
  const entry = callState.getEntry(userID);
  if (!entry || entry.status !== 'in_call') return false;

  const peerId = entry.peerId;
  const callKey = entry.callId != null ? String(entry.callId) : null;
  const ownerDeviceId = callKey
    ? callDeviceOwnership.getActiveDeviceId(callKey, userID)
    : null;

  if (!ownerDeviceId) {
    console.log(
      `[Socket] call_resume skipped (no owner) user=${userID} callId=${callKey ?? 'none'}`,
    );
    callState.scheduleResumeOwnerMissing(userID, async () => {
      try {
        console.log(
          `[Socket] resume_owner_missing timeout user=${userID} callId=${callKey ?? 'none'}`,
        );
        await endActiveCallForUser(io, userSockets, userID, 'resume_owner_missing');
        if (callKey) callDeviceOwnership.release(callKey);
      } catch (e) {
        console.warn('[Socket] resume_owner_missing endActiveCallForUser failed:', e.message);
      }
    });
    return false;
  }

  const socketDid = normalizeDeviceId(socket.deviceId);
  if (!socketDid || socketDid !== ownerDeviceId) {
    console.log(
      `[Socket] call_resume skipped (non-owner socket) user=${userID} device=${socketDid ?? 'none'} owner=${ownerDeviceId}`,
    );
    return false;
  }

  const payload = {
    callId: entry.callId,
    peerId: peerId != null ? String(peerId) : null,
    status: 'in_call',
    isVideo: !!entry.isVideo,
    role: entry.lastAnswer != null ? 'caller' : 'callee',
    answer: entry.lastAnswer ?? null,
  };
  console.log(`[Socket] call_resume user=${userID} callId=${payload.callId ?? 'none'} device=${ownerDeviceId}`);
  emitToDevice(io, userID, ownerDeviceId, 'call_resume', payload);

  callState.scheduleResumeAck(userID, async () => {
    try {
      console.log(
        `[Socket] call_resume_ack timeout user=${userID} callId=${callKey ?? 'none'}`,
      );
      await endActiveCallForUser(io, userSockets, userID, 'resume_ack_timeout');
      if (callKey) callDeviceOwnership.release(callKey);
    } catch (e) {
      console.warn('[Socket] resume_ack_timeout endActiveCallForUser failed:', e.message);
    }
  });
  return true;
}

async function _settleResumeReject(io, userSockets, userID, callId, reason) {
  const entry = callState.getEntry(userID);
  if (!entry || entry.status !== 'in_call') return false;
  if (callId != null && entry.callId != null && String(entry.callId) !== String(callId)) {
    return false;
  }
  const callKey = entry.callId != null ? String(entry.callId) : null;
  console.log(
    `[Socket] call_resume_reject user=${userID} callId=${callKey ?? 'none'} reason=${reason}`,
  );
  await endActiveCallForUser(io, userSockets, userID, reason);
  if (callKey) callDeviceOwnership.release(callKey);
  return true;
}

const callResumeHandshake = (io, socket, userSockets) => {
  socket.on('call_resume_ack', (data) => {
    try {
      if (!socket.authenticated) return;
      const userID = socket.alanyaID;
      const callId = data?.callId != null ? String(data.callId) : null;
      const entry = callState.getEntry(userID);
      if (!entry || entry.status !== 'in_call') return;
      if (callId != null && entry.callId != null && String(entry.callId) !== callId) {
        console.warn(
          `[Socket call_resume_ack] callId mismatch user=${userID} got=${callId} expected=${entry.callId}`,
        );
        return;
      }
      const callKey = entry.callId != null ? String(entry.callId) : null;
      const deviceId = normalizeDeviceId(socket.deviceId);
      // Seul le device owner peut confirmer la reprise.
      if (
        callKey &&
        callDeviceOwnership.getActiveDeviceId(callKey, userID) &&
        (!deviceId || !callDeviceOwnership.isOwnerDevice(callKey, userID, deviceId))
      ) {
        console.log(
          `[Socket] call_resume_ack ignored (non-owner) user=${userID} device=${deviceId ?? 'none'}`,
        );
        return;
      }
      callState.confirmResume(userID);
      console.log(
        `[Socket] call_resume_ack user=${userID} callId=${entry.callId ?? 'none'}`,
      );
    } catch (error) {
      console.error('[Socket call_resume_ack]', error.message);
    }
  });

  socket.on('call_resume_reject', async (data) => {
    try {
      if (!socket.authenticated) return;
      const userID = socket.alanyaID;
      const callId = data?.callId != null ? String(data.callId) : null;
      const reason = data?.reason != null ? String(data.reason) : 'no_local_call_state';
      const entry = callState.getEntry(userID);
      if (!entry || entry.status !== 'in_call') return;
      const callKey = entry.callId != null ? String(entry.callId) : null;
      const deviceId = normalizeDeviceId(socket.deviceId);
      // Non-owner : ignore — ne jamais solder un appel actif sur le device owner.
      if (
        callKey &&
        callDeviceOwnership.getActiveDeviceId(callKey, userID) &&
        (!deviceId || !callDeviceOwnership.isOwnerDevice(callKey, userID, deviceId))
      ) {
        console.log(
          `[Socket] call_resume_reject ignored (non-owner) user=${userID} device=${deviceId ?? 'none'}`,
        );
        return;
      }
      await _settleResumeReject(
        io,
        userSockets,
        userID,
        callId,
        reason === 'no_local_call_state' ? 'resume_rejected' : `resume_rejected:${reason}`,
      );
    } catch (error) {
      console.error('[Socket call_resume_reject]', error.message);
    }
  });
};

const callRejoin = (io, socket, userSockets) => {
  socket.on('call_rejoin', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { targetUserId, offer } = data || {};
      const targetID = toInt(targetUserId);
      const userID = socket.alanyaID;
      if (!targetID || !offer) return;

      const entry = callState.getEntry(userID);
      if (!entry || entry.status !== 'in_call' || Number(entry.peerId) !== targetID) {
        socket.emit('call_failed', { reason: 'Aucun appel actif à reprendre', code: 'CALL_REJOIN_INVALID' });
        return;
      }

      const callKey = entry.callId != null ? String(entry.callId) : null;
      const sourceDeviceId = normalizeDeviceId(socket.deviceId);
      if (
        !callKey ||
        !sourceDeviceId ||
        !callDeviceOwnership.isOwnerDevice(callKey, userID, sourceDeviceId)
      ) {
        console.log(
          `[Socket call_rejoin] ignored (non-owner) user=${userID} device=${sourceDeviceId ?? 'none'}`,
        );
        return;
      }

      // Clients anciens : call_rejoin vaut confirmation de reprise.
      callState.confirmResume(userID);

      const targetDeviceId = callDeviceOwnership.getActiveDeviceId(callKey, targetID);
      if (!targetDeviceId) {
        console.warn(
          `[Socket call_rejoin] pas de device cible user=${targetID} callId=${callKey} — drop (pas emitToUser)`,
        );
        return;
      }

      const payload = {
        callId: entry.callId,
        peerId: String(userID),
        offer,
        ...(data?.generation != null ? { generation: data.generation } : {}),
      };
      emitToDevice(io, targetID, targetDeviceId, 'call_rejoin_offer', payload);
    } catch (error) {
      console.error('[Socket call_rejoin]', error.message);
    }
  });

  socket.on('call_rejoin_answer', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { targetUserId, answer } = data || {};
      const targetID = toInt(targetUserId);
      const userID = socket.alanyaID;
      if (!targetID || !answer) return;

      const entry = callState.getEntry(userID);
      if (!entry || entry.status !== 'in_call' || Number(entry.peerId) !== targetID) {
        return;
      }

      const callKey = entry.callId != null ? String(entry.callId) : null;
      const sourceDeviceId = normalizeDeviceId(socket.deviceId);
      if (
        !callKey ||
        !sourceDeviceId ||
        !callDeviceOwnership.isOwnerDevice(callKey, userID, sourceDeviceId)
      ) {
        console.log(
          `[Socket call_rejoin_answer] ignored (non-owner) user=${userID} device=${sourceDeviceId ?? 'none'}`,
        );
        return;
      }

      callState.confirmResume(userID);

      const targetDeviceId = callDeviceOwnership.getActiveDeviceId(callKey, targetID);
      if (!targetDeviceId) {
        console.warn(
          `[Socket call_rejoin_answer] pas de device cible user=${targetID} callId=${callKey} — drop (pas emitToUser)`,
        );
        return;
      }

      const payload = {
        callId: entry.callId,
        peerId: String(userID),
        answer,
        ...(data?.generation != null ? { generation: data.generation } : {}),
      };
      emitToDevice(io, targetID, targetDeviceId, 'call_rejoin_answer', payload);
    } catch (error) {
      console.error('[Socket call_rejoin_answer]', error.message);
    }
  });
};

module.exports = {
  reclaimStaleBusy,
  offerCallResume,
  callUser,
  answerCall,
  rejectCall,
  processRejectCall,
  iceCandidate,
  endCall,
  endActiveCallForUser,
  leaveCallSession,
  failInvite,
  addParticipant,
  cancelAddParticipant,
  confJoin,
  confReject,
  confReady,
  createGroupCall,
  joinGroupCall,
  leaveGroupCall,
  endGroupCall,
  cleanupGroupRoomOnDisconnect,
  groupOffer,
  groupAnswer,
  groupIceCandidate,
  callMuteState,
  groupMuteState,
  callVideoState,
  groupVideoState,
  callResumeHandshake,
  callRejoin,
};
