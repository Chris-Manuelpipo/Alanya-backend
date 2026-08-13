const pool = require('../../../config/db');
const {
  getCachedDirectConversationPeer,
  isBlockedEitherWay,
} = require('../../../utils/blockUtils');
const {
  getCachedParticipants,
  setCachedParticipants,
} = require('../../../utils/conversationParticipantsCache');

// Debounce serveur : certains clients émettent typing:start à chaque frappe.
// Au-delà d'un event par fenêtre et par conversation, on ignore — l'indicateur
// côté destinataire n'a pas besoin d'être rafraîchi plus souvent.
const TYPING_DEBOUNCE_MS = 3000;

const _emitTypingToParticipants = async (io, socket, conversationID, senderID, event, payload) => {
  // Le blocage ne concerne que les conversations 1-1 (peer null en groupe).
  // Résolu UNE fois via le cache 60 s — la version précédente exécutait
  // 2 requêtes non cachées PAR participant, y compris en groupe où le
  // résultat était toujours « non supprimé ».
  const peerId = await getCachedDirectConversationPeer(conversationID, senderID);
  if (peerId != null && (await isBlockedEitherWay(senderID, peerId))) return;

  let participants = getCachedParticipants(conversationID, senderID);
  if (!participants) {
    const [rows] = await pool.execute(
      'SELECT alanyaID FROM conv_participants WHERE conversID = ? AND alanyaID != ?',
      [conversationID, senderID],
    );
    participants = rows;
    setCachedParticipants(conversationID, senderID, participants);
  }
  if (participants.length > 0) {
    // Forme tableau : une seule émission, encodage unique du payload.
    io.to(participants.map((p) => `user_${p.alanyaID}`)).emit(event, payload);
  }
  socket.to(`conversation_${conversationID}`).emit(event, payload);
};

const typingStart = (io, socket) => {
  socket.on('typing:start', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { conversationID } = data || {};
      if (!conversationID) return;

      // Debounce par (socket, conversation). Porté par l'objet socket :
      // libéré automatiquement à la déconnexion.
      const convKey = Number(conversationID);
      const now = Date.now();
      if (!socket._typingLastEmit) socket._typingLastEmit = new Map();
      const last = socket._typingLastEmit.get(convKey) || 0;
      if (now - last < TYPING_DEBOUNCE_MS) return;
      socket._typingLastEmit.set(convKey, now);

      const userID = socket.alanyaID;
      const payload = {
        conversationID: convKey,
        userID: Number(userID),
      };
      await _emitTypingToParticipants(io, socket, conversationID, userID, 'typing:started', payload);
    } catch (error) {
      console.error('[Socket typing:start]', error.message);
    }
  });
};

const typingStop = (io, socket) => {
  socket.on('typing:stop', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { conversationID } = data || {};
      if (!conversationID) return;

      // Réarme le debounce : après un stop explicite, un nouveau start doit
      // pouvoir repartir immédiatement (l'indicateur a été effacé côté pair).
      socket._typingLastEmit?.delete(Number(conversationID));

      const userID = socket.alanyaID;
      const payload = {
        conversationID: Number(conversationID),
        userID: Number(userID),
      };
      await _emitTypingToParticipants(io, socket, conversationID, userID, 'typing:stopped', payload);
    } catch (error) {
      console.error('[Socket typing:stop]', error.message);
    }
  });
};

module.exports = { typingStart, typingStop };
