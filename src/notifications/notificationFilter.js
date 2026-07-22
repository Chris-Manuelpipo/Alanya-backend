const {
  loadUserNotificationPrefs,
  loadConversationMute,
  isConversationMuted,
  applyPreviewPolicy,
} = require('./notificationPrefs');

/**
 * @returns {Promise<{allowed:boolean, reason?:string, payload?:object}>}
 */
const evaluateMessagePush = async (alanyaID, conversationId, payload, { isGroup = false } = {}) => {
  const prefs = await loadUserNotificationPrefs(alanyaID);

  if (!prefs.messagesEnabled) {
    return { allowed: false, reason: 'messages_disabled' };
  }
  if (isGroup && !prefs.groupMessagesEnabled) {
    return { allowed: false, reason: 'group_messages_disabled' };
  }

  const mute = await loadConversationMute(conversationId, alanyaID);
  if (isConversationMuted(mute)) {
    return { allowed: false, reason: 'conversation_muted' };
  }

  const preview = applyPreviewPolicy(prefs, {
    title: payload.title,
    body: payload.body,
    senderName: payload.senderName,
    isGroup,
  });

  return {
    allowed: true,
    payload: { ...payload, ...preview },
  };
};

const evaluateTypePush = async (alanyaID, type) => {
  const prefs = await loadUserNotificationPrefs(alanyaID);
  switch (type) {
    case 'status_view':
      return prefs.statusViewEnabled
        ? { allowed: true }
        : { allowed: false, reason: 'status_view_disabled' };
    case 'meeting_invite':
    case 'meeting_reminder':
      return prefs.meetingsEnabled
        ? { allowed: true }
        : { allowed: false, reason: 'meetings_disabled' };
    case 'call':
    case 'group_call':
      return prefs.callsEnabled
        ? { allowed: true }
        : { allowed: false, reason: 'calls_disabled' };
    default:
      return { allowed: true };
  }
};

module.exports = {
  evaluateMessagePush,
  evaluateTypePush,
};
