const admin = require('../config/firebase');
const { messagePreview } = require('../utils/messagePreview');
const { getConnectedDeviceIds } = require('../utils/userSocketRegistry');
const {
  logQueued,
  logSkipped,
  logSent,
  logFailed,
  logTokenStale,
} = require('../notifications/notificationLogger');
const { buildMessagePayload } = require('../notifications/notificationContract');
const { getMessagePushOptions } = require('../notifications/notificationPolicy');

const _buildApnsConfig = (data) => {
  const type = data.type;
  const showAlert =
    type === 'message' ||
    type === 'meeting_invite' ||
    type === 'meeting_reminder' ||
    type === 'status_view';

  const aps = { 'content-available': 1 };
  if (showAlert && (data.title || data.body)) {
    aps.alert = {
      title: data.title || 'Alanya',
      body: data.body || '',
    };
    aps.sound = 'default';
  }

  return {
    headers: {
      'apns-priority': showAlert ? '10' : '5',
      'apns-push-type': showAlert ? 'alert' : 'background',
    },
    payload: { aps },
  };
};

// Types affichés à l'utilisateur : bloc `notification` Android pour que le
// système les affiche même app tuée. Les appels restent data-only pour
// déclencher CallKit via le handler Dart.
const VISIBLE_TYPES = ['message', 'meeting_invite', 'meeting_reminder', 'status_view'];
const CALL_TYPES = ['call', 'group_call'];
const CALL_TTL_MS = 60_000;

const sendDataOnlyNotification = async (fcmToken, data = {}) => {
  if (!fcmToken || fcmToken === 'INDEFINI') return;

  try {
    if (!admin.apps.length) {
      console.warn('[FCM] Firebase non initialisé — notification ignorée');
      return;
    }

    const isVisible = VISIBLE_TYPES.includes(data.type);
    const isCall = CALL_TYPES.includes(data.type);
    const isMeeting =
      data.type === 'meeting_invite' || data.type === 'meeting_reminder';

    // Messages / meetings / statut : data + notification système (filet app tuée).
    // Appels : data-only (CallKit via handler Dart).
    const message = {
      token: fcmToken,
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
      android: {
        priority: isCall || isVisible ? 'high' : 'normal',
        ttl: isCall ? CALL_TTL_MS : 86400000,
      },
      apns: _buildApnsConfig(data),
    };

    if (isVisible && (data.title || data.body)) {
      message.notification = {
        title: data.title || 'Alanya',
        body: data.body || '',
      };
      // Tag distinct obligatoire : sans tag, FCM réutilise l'id 0 et chaque
      // notif écrase la précédente dans le tiroir Android.
      let tag;
      if (data.conversationId) {
        tag = `conv_${data.conversationId}`;
      } else if (data.meetingId) {
        tag = `meeting_${data.type}_${data.meetingId}`;
      } else {
        tag = `${data.type || 'notif'}_${Date.now()}`;
      }
      message.android.notification = {
        channelId: isMeeting ? 'talky_meetings' : 'talky_messages',
        icon: 'ic_stat_notification',
        color: '#114B86',
        sound: 'default',
        tag,
      };
    }

    const messageId = await admin.messaging().send(message);
    logSent({
      type: data.type,
      eventId: data.eventId,
      msgID: data.msgID,
      conversationId: data.conversationId,
      providerMessageId: messageId,
    });
  } catch (error) {
    const code = error?.code || error?.errorInfo?.code || '';
    const staleToken =
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token' ||
      error.message?.includes('Requested entity was not found');
    if (staleToken) {
      logTokenStale({
        type: data.type,
        eventId: data.eventId,
        msgID: data.msgID,
        conversationId: data.conversationId,
        reason: code || 'stale_token',
      });
      try {
        const pool = require('../config/db');
        await pool.execute(
          'UPDATE users SET fcm_token = "INDEFINI" WHERE fcm_token = ?',
          [fcmToken],
        );
      } catch (cleanupErr) {
        console.warn('[FCM] Token cleanup failed:', cleanupErr.message);
      }
    }
    // Ne pas faire crasher le serveur pour une notif ratée
    logFailed({
      type: data.type,
      eventId: data.eventId,
      msgID: data.msgID,
      conversationId: data.conversationId,
      reason: error.message,
    });
  }
};

const sendToUser = async (alanyaID, data = {}, options = {}) => {
  try {
    const { io = null, skipIfDeviceOnline = false } = options;
    const connectedDevices =
      skipIfDeviceOnline && io ? getConnectedDeviceIds(io, alanyaID) : new Set();

    const pool = require('../config/db');
    const [rows] = await pool.execute(
      'SELECT fcm_token, device_ID FROM users WHERE alanyaID = ? AND fcm_token != "INDEFINI"',
      [alanyaID],
    );
    if (rows.length === 0) {
      console.warn(`[FCM] Pas de token pour alanyaID=${alanyaID}`);
      return;
    }

    const { fcm_token: fcmToken, device_ID: deviceId } = rows[0];

    if (skipIfDeviceOnline) {
      if (
        deviceId &&
        deviceId !== 'INDEFINI' &&
        connectedDevices.has(String(deviceId))
      ) {
        logSkipped({
          type: data.type,
          eventId: data.eventId,
          msgID: data.msgID,
          conversationId: data.conversationId,
          userId: alanyaID,
          reason: 'device_socket_online',
        });
        return;
      }
      if (
        (!deviceId || deviceId === 'INDEFINI') &&
        connectedDevices.size > 0
      ) {
        logSkipped({
          type: data.type,
          eventId: data.eventId,
          msgID: data.msgID,
          conversationId: data.conversationId,
          userId: alanyaID,
          reason: 'any_socket_online',
        });
        return;
      }
    }

    logQueued({
      type: data.type,
      eventId: data.eventId,
      msgID: data.msgID,
      conversationId: data.conversationId,
      userId: alanyaID,
      deviceId,
    });

    await sendDataOnlyNotification(fcmToken, data);
  } catch (error) {
    console.error('[FCM] sendToUser error:', error.message);
  }
};

/** True si le destinataire a au moins un socket dans la room user_{id}. */
const isUserSocketConnected = (io, alanyaID) => {
  if (!io?.sockets?.adapter?.rooms) return false;
  const room = io.sockets.adapter.rooms.get(`user_${alanyaID}`);
  return !!(room && room.size > 0);
};

/**
 * Push message à tous les participants (FCM toujours envoyé — Phase 1.1).
 * Le client supprime localement si la conversation est visible au premier plan.
 * @param {import('socket.io').Server|null} [io] — conservé pour compatibilité API, non utilisé pour skip.
 */
const notifyNewMessage = async (conversationID, senderID, senderName, fields = {}, io = null) => {
  void io;
  try {
    const {
      content,
      mediaName,
      type = 0,
      isViewOnce = false,
      isGroup = false,
      groupName = '',
      msgID,
      clientId,
      senderAvatar,
      groupAvatar,
      unreadTotal,
    } = fields;

    const body = messagePreview({
      content,
      mediaName,
      type,
      isViewOnce,
      maxLen: 100,
    });

    const pool = require('../config/db');
    const [participants] = await pool.execute(
      'SELECT alanyaID FROM conv_participants WHERE conversID = ? AND alanyaID != ?',
      [conversationID, senderID]
    );
    const pushOptions = getMessagePushOptions();

    for (const p of participants) {
      const payload = buildMessagePayload({
        msgID,
        clientId,
        conversationId: conversationID,
        senderId: senderID,
        senderName,
        senderAvatar,
        body,
        msgType: type,
        isGroup,
        groupName,
        groupAvatar,
        unreadTotal,
      });
      await sendToUser(p.alanyaID, payload, pushOptions);
    }
  } catch (error) {
    console.error('[FCM] notifyNewMessage error:', error.message);
  }
};

const notifyIncomingCall = async (idReceiver, callerID, callerName, callerPhoto, isVideo, callId) => {
  await sendToUser(idReceiver, {
    type:       'call',
    title:      callerName || 'Appel entrant',
    body:       `${callerName || 'Quelqu\'un'} vous appelle`,
    callerId:   String(callerID),
    callerName: String(callerName ?? ''),
    photo:      String(callerPhoto ?? ''),
    isVideo:    String(isVideo ?? false),
    callId:     String(callId ?? ''),
  });
};

const notifyGroupCall = async (targetUserIds = [], callerID, callerName, callerPhoto, isVideo, roomId) => {
  for (const uid of targetUserIds) {
    await sendToUser(uid, {
      type:       'group_call',
      title:      callerName || 'Appel de groupe',
      body:       `${callerName || 'Quelqu\'un'} démarre un appel de groupe`,
      callerId:   String(callerID),
      callerName: String(callerName ?? ''),
      photo:      String(callerPhoto ?? ''),
      isVideo:    String(isVideo ?? false),
      roomId:     String(roomId ?? ''),
    });
  }
};

const notifyStatusView = async (statusOwnerID, viewerName) => {
  await sendToUser(statusOwnerID, {
    type:  'status_view',
    title: 'Nouveau spectateur',
    body:  `${viewerName} a vu votre statut`,
  });
};

const notifyMeetingInvite = async (participantId, organiserName, meetingTitle, meetingTime, meetingId) => {
  await sendToUser(participantId, {
    type:          'meeting_invite',
    title:         'Nouvelle réunion',
    body:          `${organiserName} vous invite à : ${meetingTitle}`,
    meetingTitle:  String(meetingTitle),
    organiserName: String(organiserName),
    meetingTime:   String(meetingTime),
    meetingId:     String(meetingId ?? ''),
  });
};

const notifyMeetingReminder = async (participantId, meetingTitle, organiserName, meetingId) => {
  await sendToUser(participantId, {
    type:          'meeting_reminder',
    title:         'Réunion dans moins de 10 minutes',
    body:          `${meetingTitle} démarre dans moins de 10 minutes`,
    meetingTitle:  String(meetingTitle),
    organiserName: String(organiserName),
    meetingId:     String(meetingId ?? ''),
  });
};

const notifyCallEnded = async (receiverId, callerId, callerName, callId = null) => {
  await sendToUser(receiverId, {
    type:       'call_ended',
    title:      'Appel terminé',
    body:       `${callerName || 'L\'appel'} a raccroché`,
    callerId:   String(callerId),
    callerName: String(callerName ?? ''),
    callId:     String(callId ?? ''),
  });
};

module.exports = {
  sendDataOnlyNotification,
  sendToUser,
  notifyNewMessage,
  notifyIncomingCall,
  notifyGroupCall,
  notifyStatusView,
  notifyMeetingInvite,
  notifyMeetingReminder,
  notifyCallEnded,
};
