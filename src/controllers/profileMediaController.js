const pool = require('../config/db');

const MEDIA_TYPES = [1, 2]; // image, video

const getMyMedia = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const cursor = Number(req.query.cursor) || 0;

    const params = [alanyaID, ...MEDIA_TYPES, alanyaID];
    let cursorClause = '';
    if (cursor > 0) {
      cursorClause = ' AND m.msgID < ?';
      params.push(cursor);
    }
    params.push(limit + 1);

    // pool.query et non pool.execute : en requête préparée mysql2 envoie le
    // LIMIT en chaîne et MySQL répond ER_WRONG_ARGUMENTS (même contrainte que
    // messageController et broadcastService).
    // mediaThumb n'est remonté que pour les vidéos : une image a déjà son URL,
    // et la colonne est un JPEG base64 (MEDIUMTEXT) qui alourdirait la page.
    const [rows] = await pool.query(
      `SELECT m.msgID, m.conversationID, m.type, m.mediaUrl, m.mediaName,
              m.mediaDuration, m.sendAt,
              CASE WHEN m.type = 2 THEN m.mediaThumb END AS mediaThumb
         FROM message m
        WHERE m.senderID = ?
          AND m.type IN (?, ?)
          AND m.isDeleted = 0
          AND (m.deletedForID IS NULL OR m.deletedForID != ?)
          AND m.mediaUrl IS NOT NULL
          AND m.mediaUrl <> ''
          ${cursorClause}
        ORDER BY m.msgID DESC
        LIMIT ?`,
      params,
    );

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? slice[slice.length - 1].msgID : null;

    res.json({
      items: slice.map((r) => ({
        msgID: r.msgID,
        conversationID: r.conversationID,
        type: Number(r.type),
        mediaUrl: r.mediaUrl,
        mediaName: r.mediaName,
        mediaThumb: r.mediaThumb ?? null,
        mediaDuration: r.mediaDuration ?? null,
        sendAt: r.sendAt,
      })),
      nextCursor,
    });
  } catch (error) {
    console.error('[ProfileMedia] ERROR:', error);
    res.status(500).json({ error: error.message || 'Échec chargement médias' });
  }
};

module.exports = { getMyMedia };
