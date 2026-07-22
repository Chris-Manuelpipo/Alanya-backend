const pool = require('../config/db');
const {
  getCachedParticipants,
  setCachedParticipants,
} = require('./conversationParticipantsCache');

/**
 * Diffuse un accusé de livraison/lecture à la room conversation + à chaque
 * participant via sa room user_* (multi-device), comme message:received.
 */
const notifyMessageStatus = async (io, conversationID, status, byUserID, extra = {}) => {
  if (!io) return;

  const payload = {
    conversationID: Number(conversationID),
    status,
    byUserID: Number(byUserID),
    // Instant exact (horloge serveur) pour affichage côté expéditeur.
    at: extra.at ?? new Date().toISOString(),
  };

  io.to(`conversation_${conversationID}`).emit('message:status', payload);

  try {
    let participants = getCachedParticipants(conversationID, byUserID);
    if (!participants) {
      const [rows] = await pool.execute(
        'SELECT alanyaID FROM conv_participants WHERE conversID = ? AND alanyaID != ?',
        [conversationID, byUserID],
      );
      participants = rows;
      setCachedParticipants(conversationID, byUserID, participants);
    }
    for (const p of participants) {
      io.to(`user_${p.alanyaID}`).emit('message:status', payload);
    }
  } catch (e) {
    console.warn('[notifyMessageStatus] failed:', e.message);
  }
};

module.exports = { notifyMessageStatus };
