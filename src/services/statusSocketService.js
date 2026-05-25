const pool = require('../config/db');

/**
 * Récupère la liste des userIDs qui ont l'auteur en contact préféré
 * (i.e. l'audience qui doit voir ses statuts).
 */
const getAudienceForAuthor = async (authorID) => {
  const [rows] = await pool.execute(
    'SELECT alanyaID FROM preferredContact WHERE idFriend = ?',
    [authorID]
  );
  return rows.map((r) => r.alanyaID);
};

const emitToUsers = (io, userIDs, event, payload) => {
  if (!io || !Array.isArray(userIDs)) return;
  for (const uid of userIDs) {
    io.to(`user_${uid}`).emit(event, payload);
  }
};

const emitToUser = (io, userID, event, payload) => {
  if (!io || !userID) return;
  io.to(`user_${userID}`).emit(event, payload);
};

module.exports = {
  getAudienceForAuthor,
  emitToUsers,
  emitToUser,
};
