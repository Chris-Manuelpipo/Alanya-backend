const pool = require('../config/db');
const { isBlockedBy, getCachedDirectConversationPeer } = require('./blockUtils');
const { notifyMessageStatus } = require('./notifyMessageStatus');
const { avancerRepereGroupe, KIND_DELIVERED } = require('./groupReceipts');

/**
 * Marque les messages entrants d'une conversation comme REMIS (status 2) et
 * notifie l'expéditeur. Chemin unique partagé par les deux déclencheurs :
 *   - socket `message:delivered` (app vivante, message reçu en temps réel) ;
 *   - POST /api/messages/delivered (app fermée, accusé émis par la couche push).
 *
 * Idempotent : l'UPDATE est gardé par `status = 1`, donc un second appel ne
 * touche aucune ligne. `changed` permet à l'appelant de ne pas rediffuser un
 * `message:status` inutile.
 *
 * @returns {Promise<{changed: boolean, skipped?: string}>}
 */
const markConversationDeliveredBy = async ({
  conversationID,
  recipientID,
  io = null,
}) => {
  const convID = Number(conversationID);
  const userID = Number(recipientID);
  if (!convID || !userID) return { changed: false, skipped: 'bad_args' };

  // Ne pas renvoyer d'accusé à quelqu'un qui nous a bloqué.
  const peerId = await getCachedDirectConversationPeer(convID, userID);
  if (peerId != null && (await isBlockedBy(userID, peerId))) {
    return { changed: false, skipped: 'blocked' };
  }

  // Groupe : repère de réception de ce membre (« Infos du message »,
  // migration 096). Sans effet en 1-1.
  await avancerRepereGroupe({ conversationID: convID, alanyaID: userID, kind: KIND_DELIVERED });

  const [res] = await pool.execute(
    `UPDATE message SET status = 2, deliveredAt = NOW()
     WHERE conversationID = ? AND senderID != ? AND status = 1`,
    [convID, userID],
  );
  await pool.execute(
    `UPDATE conversation SET lastMessageStatus = 2
     WHERE conversID = ? AND lastMessageSenderID <> ? AND lastMessageStatus < 2`,
    [convID, userID],
  );

  const changed = (res?.affectedRows ?? 0) > 0;
  if (changed) await notifyMessageStatus(io, convID, 2, userID);
  return { changed };
};

module.exports = { markConversationDeliveredBy };
