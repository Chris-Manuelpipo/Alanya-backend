/** Maintient conversation.message_count (migration 041). */
async function incrementMessageCount(conn, conversationId, delta = 1) {
  await conn.execute(
    'UPDATE conversation SET message_count = GREATEST(0, message_count + ?) WHERE conversID = ?',
    [delta, conversationId],
  );
}

async function refreshMessageCount(conn, conversationId) {
  await conn.execute(
    `UPDATE conversation c
     SET message_count = (
       SELECT COUNT(*) FROM message m
       WHERE m.conversationID = c.conversID AND m.isDeleted = 0
     )
     WHERE c.conversID = ?`,
    [conversationId],
  );
}

module.exports = { incrementMessageCount, refreshMessageCount };
