const { isBlockedBy, getCachedDirectConversationPeer } = require('../../../utils/blockUtils');
const { markConversationDeliveredBy } = require('../../../utils/deliveryReceiptUtils');
const { markConversationReadBy } = require('../../../utils/readReceiptUtils');

const messageDelivered = (io, socket) => {
  socket.on('message:delivered', async (data) => {
    if (!socket.authenticated) return;
    const { conversationID } = data || {};
    const userID = socket.alanyaID;
    if (!conversationID || !userID) return;
    try {
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
