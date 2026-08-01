const pool = require('../config/db');
const { notifyMessageStatus } = require('./notifyMessageStatus');
const { loadUserPrivacyPrefs } = require('../services/privacyPrefsService');

/**
 * Marque les messages entrants comme lus, remet unreadCount à 0 pour le lecteur,
 * met à jour lastMessageStatus sur la conversation, et notifie l'expéditeur.
 */
const markConversationReadBy = async ({
  conversationID,
  readerID,
  io = null,
}) => {
  await pool.execute(
    'UPDATE conv_participants SET unreadCount = 0 WHERE conversID = ? AND alanyaID = ?',
    [conversationID, readerID],
  );

  const prefs = await loadUserPrivacyPrefs(readerID);
  const sendReceipts = !!prefs.readReceiptsEnabled;

  if (sendReceipts) {
    await pool.execute(
      `UPDATE message SET status = 3, readAt = NOW(),
              deliveredAt = COALESCE(deliveredAt, NOW())
       WHERE conversationID = ? AND senderID != ? AND status < 3`,
      [conversationID, readerID],
    );
    await pool.execute(
      `UPDATE conversation SET lastMessageStatus = 3
       WHERE conversID = ? AND lastMessageSenderID <> ? AND lastMessageStatus < 3`,
      [conversationID, readerID],
    );

    await notifyMessageStatus(io, conversationID, 3, readerID);
  }

  if (io) {
    io.to(`user_${readerID}`).emit('inbox:sync', {
      conversationID: Number(conversationID),
      unreadCount: 0,
      reason: 'read',
    });
  }

  if (!sendReceipts) return;

  // Sync de lecture vers les AUTRES appareils du lecteur, pour qu'ils retirent
  // leur notification. `inbox:sync` ci-dessus ne touche que les appareils
  // connectés en socket ; celui qui est fermé n'a que cette push.
  //
  // L'appel vivait dans le seul handler socket `message:read`, alors que le
  // chemin qui en a le plus besoin est justement l'HTTP : c'est celui de
  // l'action « Lu » de la notification, app fermée. Ici, les deux en profitent.
  //
  // `require` tardif : notificationService remonte jusqu'à ce module par
  // transitivité, un require en tête de fichier créerait un cycle.
  // `setImmediate` : hors du chemin critique, un échec FCM ne doit pas faire
  // échouer la lecture.
  setImmediate(() => {
    const { notifyMessageReadSync } = require('../services/notificationService');
    notifyMessageReadSync(readerID, conversationID).catch((e) =>
      console.warn('[FCM message_read_sync]', e.message),
    );
  });
};

module.exports = { markConversationReadBy };
