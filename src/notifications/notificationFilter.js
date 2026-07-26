const {
  loadUserNotificationPrefs,
  loadConversationMute,
  isConversationMuted,
  applyPreviewPolicy,
} = require('./notificationPrefs');

/**
 * @returns {Promise<{allowed:boolean, reason?:string, payload?:object}>}
 */
const evaluateMessagePush = async (
  alanyaID,
  conversationId,
  payload,
  { isGroup = false, isMentioned = false } = {},
) => {
  const prefs = await loadUserNotificationPrefs(alanyaID);

  // Notifications coupées ou conversation en sourdine : on n'affiche rien, mais
  // on envoie quand même une push SILENCIEUSE (data-only, sans alerte ni son).
  // Sans elle, le terminal ne pourrait pas accuser réception quand l'app est
  // fermée, et l'expéditeur resterait bloqué sur une seule coche.
  // Titre et corps sont retirés : rien ne sera affiché, et le contenu du
  // message n'a pas à voyager vers un terminal qui n'en fera rien.
  const silence = (reason) => {
    const { title: _t, body: _b, ...rest } = payload;
    return { allowed: true, silent: true, reason, payload: { ...rest, silent: '1' } };
  };

  if (!prefs.messagesEnabled) {
    return silence('messages_disabled');
  }
  if (isGroup && !prefs.groupMessagesEnabled) {
    return silence('group_messages_disabled');
  }

  const mute = await loadConversationMute(conversationId, alanyaID);
  const muted = isConversationMuted(mute);
  const mentionsOnly = !!mute.mentionsOnly;

  // `mentionsOnly` était lu par loadConversationMute mais n'entrait dans AUCUNE
  // décision : activer « uniquement les mentions » se comportait exactement
  // comme une sourdine totale. Les deux branches ci-dessous lui donnent enfin
  // son sens.
  //
  // 1. En sourdine : la mention perce le silence — c'est tout l'intérêt de
  //    l'option. Sans elle, on retombe sur le comportement précédent.
  if (muted && !(mentionsOnly && isMentioned)) {
    return silence('conversation_muted');
  }
  // 2. Pas en sourdine mais « uniquement les mentions » : on filtre le bruit
  //    d'un groupe bavard sans le rendre complètement silencieux.
  if (!muted && mentionsOnly && isGroup && !isMentioned) {
    return silence('mentions_only');
  }

  const preview = applyPreviewPolicy(prefs, {
    title: payload.title,
    body: payload.body,
    senderName: payload.senderName,
    isGroup,
  });

  return {
    allowed: true,
    payload: {
      ...payload,
      ...preview,
      soundEnabled: prefs.soundEnabled ? '1' : '0',
    },
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
