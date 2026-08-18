const pool = require('../config/db');

const MEDIA_TYPES = [1, 2]; // image, video

// Poids inconnu (messages antérieurs à la migration 018) : -1 les range en fin
// de tri « plus lourds » au lieu de les laisser flotter selon l'humeur de MySQL
// sur les NULL, et donne au curseur composite une valeur toujours comparable.
const SIZE_EXPR = 'COALESCE(m.mediaSize, -1)';

/// Curseur du tri par poids : "<taille>_<msgID>". Un simple msgID ne suffit
/// pas, l'ordre n'étant plus celui des identifiants.
const parseSizeCursor = (raw) => {
  const [size, msgID] = String(raw ?? '').split('_');
  const s = Number(size);
  const m = Number(msgID);
  return Number.isFinite(s) && Number.isFinite(m) && m > 0 ? { size: s, msgID: m } : null;
};

const getMyMedia = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const bySize = req.query.sort === 'size';

    const params = [alanyaID, ...MEDIA_TYPES, alanyaID];
    let cursorClause = '';
    if (bySize) {
      const cursor = parseSizeCursor(req.query.cursor);
      if (cursor) {
        cursorClause = ` AND (${SIZE_EXPR} < ? OR (${SIZE_EXPR} = ? AND m.msgID < ?))`;
        params.push(cursor.size, cursor.size, cursor.msgID);
      }
    } else {
      const cursor = Number(req.query.cursor) || 0;
      if (cursor > 0) {
        cursorClause = ' AND m.msgID < ?';
        params.push(cursor);
      }
    }
    params.push(limit + 1);

    const orderBy = bySize
      ? `${SIZE_EXPR} DESC, m.msgID DESC`
      : 'm.msgID DESC';

    // pool.query et non pool.execute : en requête préparée mysql2 envoie le
    // LIMIT en chaîne et MySQL répond ER_WRONG_ARGUMENTS (même contrainte que
    // messageController et broadcastService).
    // mediaThumb n'est remonté que pour les vidéos : une image a déjà son URL,
    // et la colonne est un JPEG base64 (MEDIUMTEXT) qui alourdirait la page.
    const [rows] = await pool.query(
      `SELECT m.msgID, m.conversationID, m.type, m.mediaUrl, m.mediaName,
              m.mediaDuration, m.mediaSize, m.sendAt,
              CASE WHEN m.type = 2 THEN m.mediaThumb END AS mediaThumb
         FROM message m
        WHERE m.senderID = ?
          AND m.type IN (?, ?)
          AND m.isDeleted = 0
          AND (m.deletedForID IS NULL OR m.deletedForID != ?)
          AND m.mediaUrl IS NOT NULL
          AND m.mediaUrl <> ''
          ${cursorClause}
        ORDER BY ${orderBy}
        LIMIT ?`,
      params,
    );

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const last = slice[slice.length - 1];

    // Tri récent : curseur numérique, comme avant, pour ne pas casser les
    // versions de l'app déjà installées. Tri par poids : curseur composite.
    let nextCursor = null;
    if (hasMore && last) {
      nextCursor = bySize
        ? `${last.mediaSize ?? -1}_${last.msgID}`
        : last.msgID;
    }

    res.json({
      items: slice.map((r) => ({
        msgID: r.msgID,
        conversationID: r.conversationID,
        type: Number(r.type),
        mediaUrl: r.mediaUrl,
        mediaName: r.mediaName,
        mediaThumb: r.mediaThumb ?? null,
        mediaDuration: r.mediaDuration ?? null,
        mediaSize: r.mediaSize ?? null,
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
