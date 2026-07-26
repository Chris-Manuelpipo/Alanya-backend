const pool = require('../../../config/db');
const { isBlockedBy, getCachedDirectConversationPeer } = require('../../../utils/blockUtils');
const { markConversationDeliveredBy } = require('../../../utils/deliveryReceiptUtils');
const { markConversationReadBy } = require('../../../utils/readReceiptUtils');

/**
 * L'émetteur est-il réellement membre de cette conversation ?
 *
 * `conversationID` vient du CLIENT et n'était vérifié nulle part : ni ici, ni
 * dans markConversationReadBy / markConversationDeliveredBy, dont l'UPDATE ne
 * porte que sur `conversationID`. Les `conversID` étant des entiers
 * séquentiels donc énumérables, n'importe quel compte authentifié pouvait
 * marquer lus ou remis les messages de TOUTE la plateforme, et faire afficher
 * la double coche à des expéditeurs dont personne n'avait ouvert le message.
 *
 * Les jumeaux HTTP de ces deux handlers sont gardés (`requireParticipant` sur
 * POST /conversations/:id/read, et un SELECT explicite dans
 * POST /messages/delivered) ; le chemin socket était resté nu.
 */
async function estMembre(conversationID, alanyaID) {
  try {
    const [rows] = await pool.execute(
      'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ? LIMIT 1',
      [conversationID, alanyaID],
    );
    return rows.length > 0;
  } catch (e) {
    // En cas d'échec de la vérification, on REFUSE : un accusé perdu se
    // rattrape au prochain passage, un accusé forgé ne se rattrape pas.
    console.error('[Socket receipts] vérification d\'appartenance:', e.message);
    return false;
  }
}

const messageDelivered = (io, socket) => {
  socket.on('message:delivered', async (data) => {
    if (!socket.authenticated) return;
    const { conversationID } = data || {};
    const userID = socket.alanyaID;
    if (!conversationID || !userID) return;
    try {
      if (!(await estMembre(conversationID, userID))) return;

      // Chemin partagé avec POST /api/messages/delivered, l'accusé émis par la
      // couche push quand l'app du destinataire est fermée.
      await markConversationDeliveredBy({ conversationID, recipientID: userID, io });
    } catch (e) {
      console.error('[Socket message:delivered]', e.code || '', e.message);
    }
  });
};

const messageRead = (io, socket) => {
  socket.on('message:read', async (data) => {
    if (!socket.authenticated) return;
    const { conversationID } = data || {};
    const userID = socket.alanyaID;
    if (!conversationID || !userID) return;
    try {
      if (!(await estMembre(conversationID, userID))) return;

      // Contrôle propre au chemin socket, absent de l'utilitaire : pas d'accusé
      // de lecture vers quelqu'un qui m'a bloqué.
      const peerId = await getCachedDirectConversationPeer(conversationID, userID);
      if (peerId != null && await isBlockedBy(userID, peerId)) return;

      // Chemin partagé avec POST /api/conversations/:id/read. Ce handler en
      // dupliquait les trois UPDATE mot pour mot, et c'était le seul des deux à
      // déclencher la sync de lecture multi-appareil.
      await markConversationReadBy({ conversationID, readerID: userID, io });
    } catch (e) {
      console.error('[Socket message:read]', e.code || '', e.message);
    }
  });
};

module.exports = { messageDelivered, messageRead };
