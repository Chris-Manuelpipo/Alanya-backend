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
const { emitToUser, isUserOnline } = require('../../utils/userSocketRegistry');

// ─────────────────────────────────────────────────────────────────────────────
// CONTRAT D'EVENTS — appels 1-à-1
//
// Client → Serveur :
//   call_user     { targetUserId, callerId, callerName, callerPhoto, isVideo, offer }
//   answer_call   { callerId, answer }
//   reject_call   { callerId }
//   end_call      { targetUserId, mode? }
//   ice_candidate { targetUserId, candidate }
//
// Serveur → Client :
//   incoming_call { callId, callerId, callerName, callerPhoto, isVideo, offer }
//   call_answered { answer }
//   call_rejected { callId? }
//   call_ended    { callId? }
//   call_failed   { reason, code? }                     — erreur (hors-ligne, données invalides…)
//                 code CALL_SELF : la cible est l'appelant lui-même.
//   call_busy     { callId, targetId, reason:'busy' }   — cible déjà ringing / in_call
//   call_no_answer{ callId, targetId, reason:'no_answer' } — timeout serveur sans réponse
//   ice_candidate { candidate }
//
// État autoritaire par userId (callState) : idle | ringing | in_call.
//  - call_user  : cible occupée → call_busy (pas d'incoming_call ni FCM) ; sinon les
//                 deux participants passent « ringing » + timer no-answer (45 s).
//  - answer_call: les deux participants passent « in_call ».
//  - reject/end/timeout/disconnect : les deux repassent « idle ».
//  - Tous les états terminaux émettent le FCM call_ended (avec callId) nécessaire pour
//    couper la sonnerie/CallKit du destinataire réveillé en arrière-plan.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// CONTRAT D'EVENTS — « Ajouter à l'appel » (transfert assisté, 3 participants max)
//
// Client → Serveur :
//   call_add_participant { callId?, targetUserId }  — demande d'ajout, pose le verrou
//   call_add_cancel      { }                        — annule l'invitation (son auteur seul)
//   call_conf_join       { }                        — l'invité accepte
//   call_conf_reject     { }                        — l'invité refuse
//   end_call             { … }                      — vaut « je pars » quand une session existe
//
// Serveur → Client :
//   call_add_pending  { sessionId, callId, invitee, byUserId }  — aux 2 présents
//   call_conf_invite  { sessionId, callId, from, peers, isVideo } — à l'invité (+ FCM)
//   call_conf_joined  { sessionId, user }           — aux présents : déclenche leur offre
//   call_conf_peers   { sessionId, peers }          — à l'invité : qui va lui offrir
//   call_conf_failed  { sessionId, userId, reason } — declined|busy|offline|no_answer|cancelled
//   call_conf_left    { sessionId, userId, remaining } — aux restants
//   call_add_rejected { code }                      — ADD_ALREADY_USED|TARGET_BUSY|
//                                                     TARGET_BLOCKED|NOT_IN_CALL|TARGET_SELF
//
// Le droit d'ajout est porté par callSessions : pas de session = droit disponible.
// Un appel 1-à-1 ordinaire n'ouvre aucune session — le chemin nominal est inchangé.
// Le maillage média réutilise tel quel group_offer / group_answer / group_ice_candidate.
// ─────────────────────────────────────────────────────────────────────────────

// Délai serveur avant de déclarer un appel « sans réponse » (marge > sonnerie CallKit 30 s).
const NO_ANSWER_MS = 45 * 1000;

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
      const lastMessageType = isVideo ? 6 : 5; // 5=appel audio, 6=appel vidéo (réservés)
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
  });

  // Coupe la sonnerie/CallKit du destinataire s'il a été réveillé en arrière-plan.
  notifyCallEnded(targetID, callerID, 'Appel manqué', callID)
    .catch((err) => console.warn('[Socket call_user] no-answer notifyCallEnded error:', err.message));
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

  const { sessionId, originCallId } = session;
  const wasPending = callSessions.isPending(session, userID);
  const { remaining } = callSessions.removeParticipant(sessionId, userID);

  console.log(
    `[Socket] leaveCallSession user=${userID} session=${sessionId} ` +
    `pending=${wasPending} restants=[${remaining}] reason=${reason}`,
  );

  callState.cancelDisconnectGrace(userID);
  pendingCalls.clear(userID);

  // L'invité s'en va avant d'être entré : simple échec d'invitation. Les deux
  // présents n'ont jamais quitté leur appel 1-à-1, on n'y touche pas.
  if (wasPending) {
    callState.clear(userID);
    for (const uid of remaining) {
      emitToUser(io, uid, 'call_conf_failed', {
        sessionId,
        userId: String(userID),
        reason: reason === 'disconnect' ? 'offline' : 'declined',
      });
    }
    return true;
  }

  callState.clear(userID);

  // Ses lignes d'historique sont closes ; celles des autres restent ouvertes
  // tant qu'ils se parlent.
  await closeSessionHistoryFor(sessionId, userID);

  // Deux personnes ou plus continuent : elles se désignent mutuellement pour
  // que « occupé », la déconnexion et la fin d'appel restent cohérents.
  if (remaining.length >= 2) {
    const [first, second] = remaining;
    callState.setPeer(first, second);
    callState.setPeer(second, first);

    for (const uid of remaining) {
      emitToUser(io, uid, 'call_conf_left', {
        sessionId,
        userId: String(userID),
        remaining: remaining.map(String),
      });
    }
    return true;
  }

  // Il ne reste qu'une personne : plus d'appel du tout.
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

    await closeSessionHistoryFor(sessionId, last);
    await closeCallHistory(io, userSockets, lastCallId);
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
function reclaimStaleBusy(io, userID) {
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
      const callerID = toInt(callerId) || socket.alanyaID;

      console.log(`[Socket call_user] 📞 Appel: ${callerID} → ${targetID} (${isVideo ? 'vidéo' : 'audio'})`);

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

      const incomingPayload = {
        callId:      callID != null ? String(callID) : null,
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
      const { callerId, answer } = data;

      const callerID   = toInt(callerId);
      const receiverID = socket.alanyaID;
      if (!callerID || !answer) {
        console.warn('[Socket answer_call] ** Données invalides', { callerID, answerExists: !!answer });
        return;
      }

      console.log(`[Socket answer_call] 📞 Réponse: Receiver ${receiverID} → Caller ${callerID}`);

      // L'appel est traité : plus besoin de le rejouer au destinataire.
      pendingCalls.clear(receiverID);

      // État autoritaire : les deux participants passent « in_call » (annule le
      // timer « pas de réponse » armé côté destinataire).
      const callerEntry = callState.getEntry(callerID);
      const callId = callerEntry?.callId ?? null;
      const isVideo = !!callerEntry?.isVideo;
      callState.setInCall(receiverID, { callId, peerId: callerID, isVideo });
      callState.setInCall(callerID, { callId, peerId: receiverID, lastAnswer: answer, isVideo });

      // Lie l'appel à CE socket destinataire : la déconnexion de ce socket précis
      // doit nettoyer l'appel même si le compte garde d'autres sockets ouverts
      // (sinon état « in_call » orphelin → occupé à tort). Voir handleDisconnect.
      socket.currentCallID = callId;
      socket.currentCallTarget = callerID;

      try {
        const [result] = await pool.execute(
          `UPDATE callHistory
           SET start_time = NOW(), status = 1
           WHERE IDcall = (
             SELECT IDcall FROM (
               SELECT IDcall FROM callHistory
               WHERE idCaller = ? AND idReceiver = ?
               ORDER BY created_at DESC
               LIMIT 1
             ) AS sub
           )`,
          [callerID, receiverID]
        );
        console.log(`[Socket answer_call] !! DB updated: ${result.affectedRows} row(s)`);
      } catch (dbErr) {
        console.warn('[Socket answer_call] DB update failed:', dbErr.message);
      }

      if (isUserOnline(io, callerID)) {
        console.log(`[Socket answer_call] !! Envoi call_answered à user_${callerID}`);
        emitToUser(io, callerID, 'call_answered', {
          answer,
          callId: callId != null ? String(callId) : null,
        });
      } else {
        console.warn(`[Socket answer_call] ** Caller ${callerID} non trouvé en ligne.`);
      }
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
async function processRejectCall({ io, userSockets, callerID, receiverID, callIdHint = null }) {
  if (!callerID || !receiverID) {
    return { ok: false, reason: 'invalid_ids' };
  }

  // Garde anti-fratricide : un refus qui désigne explicitement un AUTRE appel
  // que celui en cours entre ces deux utilisateurs est un refus tardif (ex.
  // nettoyage cold-start d'une notification CallKit résiduelle côté client).
  // Dans ce cas on marque le vieil appel refusé en DB, mais on ne touche ni à
  // pendingCalls ni à callState — sinon un débris local tuerait l'appel qui
  // sonne réellement.
  const hintID = toInt(callIdHint);
  if (hintID) {
    const receiverEntry = callState.getEntry(toInt(receiverID));
    const currentPairCallID =
      receiverEntry && String(receiverEntry.peerId) === String(callerID)
        ? toInt(receiverEntry.callId)
        : null;
    if (currentPairCallID && currentPairCallID !== hintID) {
      try {
        // `status = 0` uniquement : ne pas réécrire un appel déjà classé
        // (répondu/refusé/manqué) par le flux normal.
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

  // Appel refusé : ne pas le rejouer au destinataire.
  pendingCalls.clear(receiverID);

  // État autoritaire : les deux participants repassent « idle ».
  callState.clear(receiverID);
  callState.clear(callerID);

  let rejectedCallID = toInt(callIdHint);
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

  // Met à jour la conversation + notifie les deux côtés (discussions + logs d'appel).
  finalizeCallAndNotify(io, userSockets, rejectedCallID)
    .catch((err) => console.warn('[processRejectCall] finalizeCallAndNotify error:', err.message));

  const rejectedCallIdStr = rejectedCallID != null ? String(rejectedCallID) : null;
  emitToUser(io, callerID, 'call_rejected', { callId: rejectedCallIdStr });

  // FCM au caller pour arrêter la sonnerie (cas où receiver est en background)
  notifyCallEnded(callerID, receiverID, 'Destinataire', rejectedCallID)
    .catch((err) => console.warn('[processRejectCall] FCM notifyCallEnded error:', err.message));

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

      emitToUser(io, targetID, 'ice_candidate', { candidate });
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

      // Préférer le callId d'état (fiable) avant clear — évite un FCM call_ended
      // sans callId qui ne pourrait pas bloquer un FCM `call` tardif.
      const selfEntry = callState.getEntry(callerID);
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
        emitToUser(io, targetID, 'call_ended', { callId: endedCallIdStr });

        // Envoyer FCM au receiver pour arrêter la sonnerie (cas où receiver est en background)
        notifyCallEnded(targetID, callerID, 'L\'appelant', endedCallID)
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

/**
 * Solde une invitation en cours sur un échec.
 *
 * Détruit la session, ce qui rend mécaniquement le droit d'ajout aux deux
 * présents, puis coupe la sonnerie de l'invité. Les présents n'ont jamais quitté
 * leur appel 1-à-1 : il n'y a rien à y rétablir.
 *
 * @param {string} reason declined | busy | offline | no_answer | cancelled
 */
function failInvite(io, sessionId, reason) {
  const session = callSessions.get(sessionId);
  if (!session?.pending) return;

  const inviteeID = session.pending.userId;
  const present = callSessions.participantIds(session);

  console.log(`[Socket call_add] ✖ invitation soldée session=${sessionId} invité=${inviteeID} raison=${reason}`);

  callSessions.abortPending(sessionId);
  callState.clear(inviteeID);
  pendingCalls.clear(inviteeID);

  for (const uid of present) {
    emitToUser(io, uid, 'call_conf_failed', {
      sessionId,
      userId: String(inviteeID),
      reason,
    });
  }

  // L'invité qui a lui-même refusé n'a plus rien à couper. Dans tous les autres
  // cas il faut éteindre son écran d'appel entrant — socket pour le premier plan,
  // FCM pour l'app réveillée en arrière-plan.
  if (reason !== 'declined') {
    emitToUser(io, inviteeID, 'call_ended', { callId: sessionId });
    notifyCallEnded(inviteeID, present[0] ?? null, 'Correspondant', sessionId)
      .catch((err) => console.warn('[Socket call_add] FCM call_ended error:', err.message));
  }
}

const addParticipant = (io, socket, userSockets) => {
  socket.on('call_add_participant', async (data) => {
    try {
      if (!socket.authenticated) return;

      const { targetUserId, callerName, callerPhoto } = data || {};
      const inviteeID   = toInt(targetUserId);
      const requesterID = socket.alanyaID;

      const reject = (code) => socket.emit('call_add_rejected', { code });

      if (!inviteeID || !requesterID) return reject('INVALID');
      if (inviteeID === requesterID) return reject('TARGET_SELF');

      // Le demandeur doit être en communication, et à deux seulement.
      const entry = callState.getEntry(requesterID);
      if (!entry || entry.status !== 'in_call' || entry.peerId == null) {
        return reject('NOT_IN_CALL');
      }
      const peerID = toInt(entry.peerId);
      if (!peerID) return reject('NOT_IN_CALL');
      if (peerID === inviteeID) return reject('TARGET_ALREADY_IN_CALL');

      // Disponibilité de l'invité, après purge d'un « occupé » fantôme.
      reclaimStaleBusy(io, inviteeID);
      if (callState.isBusyForNewCall(inviteeID, requesterID, pendingCalls)) {
        console.log(`[Socket call_add] ⛔ invité occupé: ${inviteeID} (${callState.get(inviteeID)})`);
        return reject('TARGET_BUSY');
      }

      // ── Verrou ──────────────────────────────────────────────────────────────
      // Posé ICI, avant le moindre await : c'est ce qui arbitre deux appuis
      // simultanés sur « Ajouter ». Les vérifications asynchrones qui suivent
      // relâchent le verrou en cas d'échec (failInvite détruit la session).
      const session = callSessions.openWithPending({
        originCallId: entry.callId ?? null,
        isVideo: !!entry.isVideo,
        participants: [requesterID, peerID],
        inviteeId: inviteeID,
        byUserId: requesterID,
      });
      if (!session) {
        console.log(`[Socket call_add] ⛔ droit déjà utilisé: demandeur=${requesterID}`);
        return reject('ADD_ALREADY_USED');
      }
      const { sessionId } = session;

      // Un ajout met en relation deux personnes qui ne se sont rien demandé :
      // on vérifie le blocage sur LES DEUX paires, pas seulement celle de
      // l'invitant. Un blocage est un refus de contact déjà exprimé.
      const [blockedByRequester, blockedByPeer] = await Promise.all([
        isBlockedEitherWay(requesterID, inviteeID),
        isBlockedEitherWay(peerID, inviteeID),
      ]);
      if (blockedByRequester || blockedByPeer) {
        console.log(`[Socket call_add] ⛔ blocage: invité=${inviteeID}`);
        callSessions.abortPending(sessionId);
        return reject('TARGET_BLOCKED');
      }

      // L'invité devient « occupé » : un quatrième appelant le trouvera pris.
      callState.setRinging(inviteeID, {
        callId: sessionId,
        peerId: requesterID,
        isVideo: !!entry.isVideo,
      });

      // Expiration alignée sur celle des appels ordinaires.
      callSessions.setPendingTimer(
        sessionId,
        setTimeout(() => failInvite(io, sessionId, 'no_answer'), NO_ANSWER_MS),
      );

      const cards = await fetchUserCards([requesterID, peerID, inviteeID]);
      const fallback = (uid) => ({ id: String(uid), name: '', photo: null });
      const inviteeCard   = cards.get(inviteeID)   ?? fallback(inviteeID);
      const requesterCard = cards.get(requesterID) ?? fallback(requesterID);
      const peerCard      = cards.get(peerID)      ?? fallback(peerID);

      // Le nom transmis par le client fait foi s'il est fourni (cohérent avec
      // call_user), la base servant de repli.
      if (callerName) requesterCard.name = callerName;
      if (callerPhoto) requesterCard.photo = callerPhoto;

      console.log(
        `[Socket call_add] ➕ ${requesterID} ajoute ${inviteeID} à l'appel avec ${peerID} (session=${sessionId})`,
      );

      // Les deux présents affichent la tuile en sonnerie et perdent le bouton.
      for (const uid of [requesterID, peerID]) {
        emitToUser(io, uid, 'call_add_pending', {
          sessionId,
          callId: session.originCallId,
          invitee: inviteeCard,
          byUserId: String(requesterID),
        });
      }

      // L'invité sonne comme pour un appel ordinaire, avec le motif explicite.
      emitToUser(io, inviteeID, 'call_conf_invite', {
        sessionId,
        callId: session.originCallId,
        from: requesterCard,
        peers: [requesterCard, peerCard],
        isVideo: !!entry.isVideo,
      });

      // App fermée / arrière-plan : réveil FCM, même chemin qu'un appel entrant.
      notifyIncomingCall(
        inviteeID,
        requesterID,
        requesterCard.name,
        requesterCard.photo,
        !!entry.isVideo,
        sessionId,
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
      failInvite(io, session.sessionId, 'declined');
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
      const session = callSessions.getByUser(inviteeID);
      if (!session || !callSessions.isPending(session, inviteeID)) return;

      const { sessionId } = session;
      const present = callSessions.participantIds(session);
      const promoted = callSessions.promotePending(sessionId);
      if (!promoted) return;

      pendingCalls.clear(inviteeID);
      callState.setInCall(inviteeID, {
        callId: sessionId,
        peerId: present[0] ?? null,
        isVideo: session.isVideo,
      });

      console.log(`[Socket call_add] ✔ ${inviteeID} rejoint la session ${sessionId} (présents=[${present}])`);

      openSessionHistory(promoted, inviteeID)
        .catch((err) => console.warn('[Socket call_conf_join] historique:', err.message));

      const cards = await fetchUserCards([...present, inviteeID]);
      const fallback = (uid) => ({ id: String(uid), name: '', photo: null });
      const inviteeCard = cards.get(inviteeID) ?? fallback(inviteeID);

      // Chaque présent ouvre une connexion vers l'arrivant : ce sont eux qui
      // offrent, l'arrivant se contente de répondre — aucune collision d'offres.
      for (const uid of present) {
        emitToUser(io, uid, 'call_conf_joined', { sessionId, user: inviteeCard });
      }

      emitToUser(io, inviteeID, 'call_conf_peers', {
        sessionId,
        isVideo: session.isVideo,
        peers: present.map((uid) => cards.get(uid) ?? fallback(uid)),
      });
    } catch (error) {
      console.error('[Socket call_conf_join]', error.message);
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

      const callerID = toInt(callerId) || socket.alanyaID;
      const videoCall = !!isVideo;
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

      const fcmTargets = [];
      for (const targetID of uniqueTargets) {
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
      if (!roomId || !userId) return;

      const userID = toInt(userId) || socket.alanyaID;

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
      const { toUserId, fromUserId, offer, roomId } = data;
      const targetID = toInt(toUserId);
      if (!targetID || !offer) return;

      emitToUser(io, targetID, 'group_offer', {
        fromUserId: String(fromUserId || socket.alanyaID),
        offer,
        roomId,
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
      const { toUserId, fromUserId, answer, roomId } = data;
      const targetID = toInt(toUserId);
      if (!targetID || !answer) return;

      emitToUser(io, targetID, 'group_answer', {
        fromUserId: String(fromUserId || socket.alanyaID),
        answer,
        roomId,
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
      const { toUserId, fromUserId, candidate, roomId } = data;
      const targetID = toInt(toUserId);
      if (!targetID || !candidate) return;

      emitToUser(io, targetID, 'group_ice_candidate', {
        fromUserId: String(fromUserId || socket.alanyaID),
        candidate,
        roomId,
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

// Appel de groupe : diffuse l'état micro à tous les autres participants de la
// room (l'émetteur est exclu via `socket.to`).
const groupMuteState = (io, socket, userSockets) => {
  socket.on('group:mute_state', (data) => {
    try {
      if (!socket.authenticated) return;
      const rId = (data && data.roomId) || socket.currentGroupRoom;
      if (!rId) return;

      socket.to(`group_${rId}`).emit('group:mute_state', {
        roomId:  rId,
        userId:  String(socket.alanyaID),
        isMuted: !!(data && data.isMuted),
      });
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
const callRejoin = (io, socket, userSockets) => {
  socket.on('call_rejoin', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { targetUserId, offer } = data || {};
      const targetID = toInt(targetUserId);
      const userID = socket.alanyaID;
      if (!targetID || !offer) return;

      const entry = callState.getEntry(userID);
      if (!entry || entry.status !== 'in_call' || entry.peerId !== targetID) {
        socket.emit('call_failed', { reason: 'Aucun appel actif à reprendre', code: 'CALL_REJOIN_INVALID' });
        return;
      }

      emitToUser(io, targetID, 'call_rejoin_offer', {
        callId: entry.callId,
        peerId: String(userID),
        offer,
      });
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
      if (!entry || entry.status !== 'in_call' || entry.peerId !== targetID) {
        return;
      }

      emitToUser(io, targetID, 'call_rejoin_answer', {
        callId: entry.callId,
        peerId: String(userID),
        answer,
      });
    } catch (error) {
      console.error('[Socket call_rejoin_answer]', error.message);
    }
  });
};

module.exports = {
  reclaimStaleBusy,
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
  callRejoin,
};
