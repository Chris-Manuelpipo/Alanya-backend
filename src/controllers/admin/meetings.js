const pool = require('../../config/db'); 

// Toutes les réunions de l'application avec organisateur et nombre de participants.
const getAllMeetings = async (req, res) => {
  try {
    const limitN = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const [items] = await pool.execute(
      `SELECT m.idMeeting,
              m.idOrganiser,
              u.nom    AS organiser_nom,
              u.pseudo AS organiser_pseudo,
              CASE WHEN u.avatar_url LIKE 'http%' THEN u.avatar_url ELSE NULL END AS organiser_avatar,
              m.objet,
              m.room,
              DATE_FORMAT(m.start_time, '%Y-%m-%dT%H:%i:%s.000Z') AS start_time,
              m.duree,
              m.isEnd,
              m.type_media,
              (SELECT COUNT(*) FROM participant p WHERE p.idMeeting = m.idMeeting) AS participants,
              m.created_at
       FROM meeting m
       JOIN users u ON u.alanyaID = m.idOrganiser
       ORDER BY m.start_time DESC
       LIMIT ${limitN}`
    );
    res.json(items);
  } catch (error) {
    console.error('[Admin] getAllMeetings error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};
 
// Termine une réunion en cours (isEnd = 1).
const endMeeting = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute('SELECT idMeeting FROM meeting WHERE idMeeting = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Réunion introuvable' });
    await pool.execute('UPDATE meeting SET isEnd = 1 WHERE idMeeting = ?', [id]);
    res.json({ message: 'Réunion terminée' });
  } catch (error) {
    console.error('[Admin] endMeeting error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};
 
// Supprime une réunion + ses participants (sans restriction d'organisateur).
const deleteMeeting = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute('SELECT idMeeting FROM meeting WHERE idMeeting = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Réunion introuvable' });
    await pool.execute('DELETE FROM participant WHERE idMeeting = ?', [id]);
    await pool.execute('DELETE FROM meeting WHERE idMeeting = ?', [id]);
    res.json({ message: 'Réunion supprimée' });
  } catch (error) {
    console.error('[Admin] deleteMeeting error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { getAllMeetings, endMeeting, deleteMeeting };
