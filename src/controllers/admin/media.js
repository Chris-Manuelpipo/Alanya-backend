const pool = require('../../config/db');

// Médias partagés (messages de type image/vidéo/audio/fichier) avec
// expéditeur + nom de conversation. Renvoie un tableau MediaItem[].
const getAllMedia = async (req, res) => {
  try {
    const { type = '', search = '' } = req.query;

    const where = [
      'm.type IN (1, 2, 3, 4)',
      "m.mediaUrl IS NOT NULL",
      "m.mediaUrl <> ''",
      'm.isDeleted = 0',
    ];
    const params = [];

    const typeN = parseInt(type, 10);
    if ([1, 2, 3, 4].includes(typeN)) { where.push('m.type = ?'); params.push(typeN); }
    if (search) { where.push('m.mediaName LIKE ?'); params.push(`%${search}%`); }

    const pageN  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limitN = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const offset = (pageN - 1) * limitN;

    const [items] = await pool.execute(
      `SELECT m.msgID AS id,
              m.senderID,
              u.nom        AS sender_nom,
              u.pseudo     AS sender_pseudo,
              u.avatar_url AS sender_avatar,
              m.conversationID,
              COALESCE(
                CASE WHEN c.isGroup = 1 THEN c.GroupName
                     ELSE (SELECT u2.nom FROM conv_participants cp
                           JOIN users u2 ON u2.alanyaID = cp.alanyaID
                           WHERE cp.conversID = c.conversID AND cp.alanyaID <> m.senderID
                           ORDER BY cp.id LIMIT 1)
                END, 'Conversation') AS conversation_name,
              m.type,
              m.mediaUrl,
              COALESCE(m.mediaName, 'fichier') AS mediaName,
              m.sendAt
       FROM message m
       JOIN users u        ON u.alanyaID  = m.senderID
       JOIN conversation c ON c.conversID = m.conversationID
       WHERE ${where.join(' AND ')}
       ORDER BY m.sendAt DESC
       LIMIT ${limitN} OFFSET ${offset}`,
      params
    );

    res.json(items);
  } catch (error) {
    console.error('[Admin] getAllMedia error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};
 
// Masque un média : soft-delete du message (isDeleted = 1). Il disparaît de
// la liste admin (filtrée sur isDeleted = 0) et côté app, tout en restant récupérable en base.

const deleteMedia = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      'SELECT msgID FROM message WHERE msgID = ? AND type IN (1, 2, 3, 4)',
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Média introuvable' });
    await pool.execute('UPDATE message SET isDeleted = 1 WHERE msgID = ?', [id]);
    res.json({ message: 'Média supprimé' });
  } catch (error) {
    console.error('[Admin] deleteMedia error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { getAllMedia, deleteMedia };
