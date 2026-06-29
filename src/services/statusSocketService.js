const pool = require('../config/db');

/**
 * Audience d'un auteur = ses contacts préférés réciproques.
 * On ne diffuse les statuts qu'aux utilisateurs X tels que :
 *   - l'auteur a ajouté X en contact préféré, ET
 *   - X a ajouté l'auteur en contact préféré.
 * Cette règle est symétrique au filtre de GET /api/status.
 */
const getAudienceForAuthor = async (authorID) => {
  const [rows] = await pool.execute(
    `SELECT mine.idFriend AS alanyaID
       FROM preferredContact AS mine
       JOIN preferredContact AS theirs
         ON theirs.alanyaID = mine.idFriend
        AND theirs.idFriend = mine.alanyaID
      WHERE mine.alanyaID = ?
        AND NOT EXISTS (
          SELECT 1 FROM blocked b
          WHERE b.alanyaID = ? AND b.idCallerBlock = mine.idFriend
        )`,
    [authorID, authorID]
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
