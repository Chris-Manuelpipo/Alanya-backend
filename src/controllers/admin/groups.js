const pool = require('../../config/db');
 
// Tous les groupes de l'application avec nombre de membres et date de création
const getAllGroups = async (req, res) => {
  try {
    const { search = '' } = req.query;
    const where = ['c.isGroup = 1'];
    const params = [];
    if (search) { where.push('c.GroupName LIKE ?'); params.push(`%${search}%`); }

    const limitN = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));

    const [items] = await pool.execute(
      `SELECT c.conversID,
              c.GroupName,
              c.groupPhoto,
              c.lastMessage,
              c.lastMessageAt,
              c.createdAt,
              c.createdBy,
              c.onlyAdminsCanSend,
              c.onlyAdminsCanEditInfo,
              (SELECT COUNT(*) FROM conv_participants cp WHERE cp.conversID = c.conversID) AS members
       FROM conversation c
       WHERE ${where.join(' AND ')}
       ORDER BY c.lastMessageAt IS NULL, c.lastMessageAt DESC, c.conversID DESC
       LIMIT ${limitN}`,
      params
    );

    res.json(items);
  } catch (error) {
    console.error('[Admin] getAllGroups error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};
 
// Détails d'un groupe + liste complète des membres.
const getGroupById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      `SELECT conversID, isGroup, GroupName, groupPhoto, description,
              lastMessage, lastMessageAt, createdAt, createdBy,
              onlyAdminsCanSend, onlyAdminsCanEditInfo
       FROM conversation WHERE conversID = ?`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Groupe introuvable' });
    const g = rows[0];

    const [members] = await pool.execute(
      `SELECT u.alanyaID, u.nom, u.pseudo, u.avatar_url, u.alanyaPhone,
              u.is_online, u.last_seen, u.type_compte, cp.joinedAt, cp.role
       FROM conv_participants cp
       JOIN users u ON u.alanyaID = cp.alanyaID
       WHERE cp.conversID = ?
       ORDER BY cp.role DESC, cp.joinedAt ASC`,
      [id]
    );
    const [[{ messageCount }]] = await pool.execute(
      'SELECT COUNT(*) AS messageCount FROM message WHERE conversationID = ?',
      [id]
    );

    res.json({
      conversID: g.conversID,
      isGroup: g.isGroup,
      GroupName: g.GroupName,
      groupPhoto: g.groupPhoto,
      description: g.description,
      lastMessage: g.lastMessage,
      lastMessageAt: g.lastMessageAt,
      memberCount: members.length,
      messageCount,
      // Colonnes réelles depuis la 024. Auparavant dérivés : createdAt de
      // MIN(joinedAt), et le créateur supposé être members[0].
      createdAt: g.createdAt,
      createdBy: g.createdBy,
      onlyAdminsCanSend: g.onlyAdminsCanSend ? 1 : 0,
      onlyAdminsCanEditInfo: g.onlyAdminsCanEditInfo ? 1 : 0,
      members: members.map((m) => ({
        alanyaID: m.alanyaID,
        nom: m.nom,
        pseudo: m.pseudo,
        avatar_url: (m.avatar_url && String(m.avatar_url).startsWith('http')) ? m.avatar_url : null,
        alanyaPhone: m.alanyaPhone,
        is_online: m.is_online,
        last_seen: m.last_seen,
        type_compte: m.type_compte,
        joinedAt: m.joinedAt,
        role: Number(m.role) || 0,
      })),
    });
  } catch (error) {
    console.error('[Admin] getGroupById error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};
 
// Supprime un groupe + ses messages + ses participants.
const deleteGroup = async (req, res) => {
  try {
    const { id } = req.params;
    // `AND isGroup = 1` : sans ce filtre, saisir ou coller l'id d'une
    // conversation privée dans l'endpoint « supprimer un groupe » effaçait
    // définitivement la discussion 1-1 de deux utilisateurs et tous ses
    // messages — avec un message de succès. getAllGroups filtrait bien, lui.
    const [rows] = await pool.execute(
      'SELECT conversID FROM conversation WHERE conversID = ? AND isGroup = 1',
      [id],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Groupe introuvable' });
    await pool.execute('DELETE FROM message WHERE conversationID = ?', [id]);
    await pool.execute('DELETE FROM conv_participants WHERE conversID = ?', [id]);
    await pool.execute('DELETE FROM conversation WHERE conversID = ?', [id]);
    res.json({ message: 'Groupe supprimé' });
  } catch (error) {
    console.error('[Admin] deleteGroup error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { getAllGroups, getGroupById, deleteGroup };
