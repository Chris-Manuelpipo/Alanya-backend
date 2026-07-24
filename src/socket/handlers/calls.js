const pool = require('../../config/db');
const { notifyIncomingCall, notifyGroupCall, notifyCallEnded } = require('../../services/notificationService');
const { maxParticipants, maxInvitees } = require('../../constants/participantLimits');
const { isBlockedEitherWay } = require('../../utils/blockUtils');
const { getClientIp, parseCallMode } = require('../../utils/clientIp');
const pendingCalls = require('../state/pendingCalls');
const callState = require('../state/callState');
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
async function getOrCreateDirectConversation(userA, userB) {
  const [existing] = await pool.execute(
    `SELECT c.conversID FROM conversation c
     JOIN conv_participants cp1 ON c.conversID = cp1.conversID
     JOIN conv_participants cp2 ON c.conversID = cp2.conversID
     WHERE cp1.alanyaID = ? AND cp2.alanyaID = ? AND c.isGroup = 0
     ORDER BY (SELECT COUNT(*) FROM message m
               WHERE m.conversationID = c.conversID AND m.isDeleted = 0) DESC,
              c.lastMessageAt DESC, c.conversID DESC
     LIMIT 1`,
    [userA, userB]
  );
  if (existing.length > 0) return existing[0].conversID;

  const [result] = await pool.execute(
    'INSERT INTO conversation (isGroup, lastMessageAt) VALUES (0, NOW())'
  );
  const conversID = result.insertId;
  await pool.execute(
    'INSERT INTO conv_participants (conversID, alanyaID) VALUES (?, ?), (?, ?)',
    [conversID, userA, conversID, userB]
  );
  return conversID;
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
  return { isVideo: !!isVideo, participants };
}

/**
 * Termine l'appel 1-à-1 actif d'un utilisateur (disconnect / kill app).
 * Nettoie callState + pendingCalls, prévient le pair (socket + FCM call_ended).
 * @returns {Promise<boolean>} true si un appel a été terminé.
 */
async function endActiveCallForUser(io, userSockets, userID, reason = 'disconnect') {
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

  if (callID) {
    try {
      // status 3 = manqué / coupé sans réponse propre (disconnect pendant sonnerie
      // ou communication). La durée est recalculée si start_time existe.
      await pool.execute(
        `UPDATE callHistory
         SET status = CASE WHEN status = 0 THEN 3 ELSE status END,
             duree = GREATEST(0, TIMESTAMPDIFF(SECOND, start_time, NOW()))
         WHERE IDcall = ?`,
        [callID],
      );
    } catch (dbErr) {
      console.warn('[Socket endActiveCallForUser] DB update failed:', dbErr.message);
    }
    finalizeCallAndNotify(io, userSockets, callID)
      .catch((err) => console.warn('[Socket endActiveCallForUser] finalize error:', err.message));
  }

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
      const { roomId } = data || {};
      const rId = roomId || socket.currentGroupRoom;
      if (!rId) return;

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
  createGroupCall,
  joinGroupCall,
  leaveGroupCall,
  endGroupCall,
  groupOffer,
  groupAnswer,
  groupIceCandidate,
  callMuteState,
  groupMuteState,
  callVideoState,
  groupVideoState,
  callRejoin,
};
