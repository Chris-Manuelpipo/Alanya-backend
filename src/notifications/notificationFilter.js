const {
  loadUserNotificationPrefs,
  loadConversationMute,
  isConversationMuted,
  applyPreviewPolicy,
} = require('./notificationPrefs');
const { loadUserDndSchedule, isDndActive } = require('../services/dndScheduleService');

/**
 * @returns {Promise<{allowed:boolean, reason?:string, payload?:object}>}
 */
const evaluateMessagePush = async (
  alanyaID,
  conversationId,
  payload,
  { isGroup = false, isMentioned = false, avatarAllowed = true, preloaded = {} } = {},
) => {
  // `preloaded` permet au fan-out de groupe de fournir prefs/dnd/mute chargés
  // en batch (une requête pour tous les destinataires) au lieu de 3 requêtes
  // unitaires par destinataire. Sans lui, comportement inchangé.
  const prefs = preloaded.prefs ?? (await loadUserNotificationPrefs(alanyaID));
  const dnd = preloaded.dnd ?? (await loadUserDndSchedule(alanyaID));

  // Notifications coupées ou conversation en sourdine : on n'affiche rien, mais
  // on envoie quand même une push SILENCIEUSE (data-only, sans alerte ni son).
  // Sans elle, le terminal ne pourrait pas accuser réception quand l'app est
  // fermée, et l'expéditeur resterait bloqué sur une seule coche.
  // Titre et corps sont retirés : rien ne sera affiché, et le contenu du
  // message n'a pas à voyager vers un terminal qui n'en fera rien. Les deux
  // avatars suivent la même règle, pour la même raison — ce sont des données
  // personnelles que rien n'affichera.
  const silence = (reason) => {
    const {
      title: _t,
      body: _b,
      senderAvatar: _sa,
      groupAvatar: _ga,
      ...rest
    } = payload;
    return { allowed: true, silent: true, reason, payload: { ...rest, silent: '1' } };
  };

  if (!prefs.messagesEnabled) {
    return silence('messages_disabled');
  }
  if (isDndActive(dnd)) {
    return silence('dnd_active');
  }
  if (isGroup && !prefs.groupMessagesEnabled) {
    return silence('group_messages_disabled');
  }

  const mute = preloaded.mute ?? (await loadConversationMute(conversationId, alanyaID));
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

  const outgoing = {
    ...payload,
    ...preview,
    soundEnabled: prefs.soundEnabled ? '1' : '0',
  };

  // Deux raisons de retirer les avatars d'une push par ailleurs autorisée :
  //
  // - `generic` masque jusqu'au nom de l'expéditeur. Laisser sa photo s'afficher
  //   à côté d'un « Nouveau message » anonyme viderait le réglage de son sens.
  //   `name_only` les garde : le nom est déjà montré, la photo est cohérente.
  // - `avatarAllowed` porte le réglage `profilePhotoVisibility` de l'expéditeur,
  //   résolu une seule fois par le fan-out. Sans lui, une photo réservée aux
  //   contacts partait vers tout un groupe par la notification, alors que l'API
  //   la masque partout ailleurs (canViewProfileField).
  // Miroir exact de `applyPreviewPolicy` : toute valeur hors 'full' /
  // 'name_only' y retombe sur l'aperçu générique. Tester `=== 'generic'`
  // laisserait passer les avatars pour une valeur inattendue en base.
  const mode = prefs.previewMode || 'full';
  const isGenericPreview = mode !== 'full' && mode !== 'name_only';

  if (!avatarAllowed || isGenericPreview) {
    delete outgoing.senderAvatar;
    delete outgoing.groupAvatar;
  }

  return { allowed: true, payload: outgoing };
};

const evaluateTypePush = async (alanyaID, type) => {
  const prefs = await loadUserNotificationPrefs(alanyaID);
  const dnd = await loadUserDndSchedule(alanyaID);
  if (isDndActive(dnd)) {
    return { allowed: false, reason: 'dnd_active' };
  }
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
