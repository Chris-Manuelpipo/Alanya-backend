const pool = require('../../../config/db');
const { shouldSuppressDirectInteraction } = require('../../../utils/blockUtils');

const _emitTypingToParticipants = async (io, socket, conversationID, senderID, event, payload) => {
  const [participants] = await pool.execute(
    'SELECT alanyaID FROM conv_participants WHERE conversID = ? AND alanyaID != ?',
    [conversationID, senderID],
  );
  let emitToRoom = false;
  for (const p of participants) {
    const suppressed = await shouldSuppressDirectInteraction(
      conversationID, senderID, p.alanyaID,
    );
    if (suppressed) continue;
    io.to(`user_${p.alanyaID}`).emit(event, payload);
    emitToRoom = true;
  }
  if (emitToRoom) {
    socket.to(`conversation_${conversationID}`).emit(event, payload);
  }
};

const typingStart = (io, socket) => {
  socket.on('typing:start', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { conversationID } = data || {};
      if (!conversationID) return;
      const userID = socket.alanyaID;
      const payload = {
        conversationID: Number(conversationID),
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
