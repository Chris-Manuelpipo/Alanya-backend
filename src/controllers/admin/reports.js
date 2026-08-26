const pool = require('../../config/db');

/**
 * File de modération.
 *
 * Le contenu du message signalé est renvoyé, contrairement au reste du panneau
 * qui s'en garde soigneusement : signaler un message, c'est demander qu'il soit
 * lu par l'équipe. Le périmètre s'arrête là — la conversation autour n'est
 * jamais servie, seulement le message désigné.
 */

const STATES = ['open', 'reviewing', 'actioned', 'dismissed'];

/**
 * Décisions enregistrables, et l'état dans lequel elles laissent le
 * signalement. `banned` n'y figure pas : bannir se fait depuis la fiche du
 * compte, où le garde `users.ban` s'applique et où l'action est déjà
 * journalisée. Un second chemin de bannissement se serait désynchronisé du
 * premier.
 */
const ACTIONS = {
  reviewing: 'reviewing',
  dismissed: 'dismissed',
  actioned: 'actioned',
};

const getReports = async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const where = [];
    const params = [];

    const state = String(req.query.state || '');
    if (STATES.includes(state)) {
      where.push('r.state = ?');
      params.push(state);
    }
    if (req.query.targetUserId) {
      where.push('r.target_user_id = ?');
      params.push(Number(req.query.targetUserId));
    }

    params.push(limit);

    // Les plus anciens d'abord parmi les ouverts : une file de modération se
    // vide par le bas, sinon les signalements du jour enterrent ceux d'hier.
    const [rows] = await pool.query(
      `SELECT r.id, r.target_type, r.target_msg_id, r.target_user_id, r.reason,
              r.note, r.state, r.created_at, r.updated_at,
              r.reporter_id, ur.nom AS reporter_nom, ur.pseudo AS reporter_pseudo,
              ut.nom AS target_nom, ut.pseudo AS target_pseudo, ut.exclus AS target_exclus,
              m.senderID AS msg_sender_id, m.type AS msg_type, m.content AS msg_content,
              m.isDeleted AS msg_deleted, m.sendAt AS msg_sent_at,
              us.nom AS msg_sender_nom, us.pseudo AS msg_sender_pseudo,
              (SELECT COUNT(*) FROM report_action a WHERE a.report_id = r.id) AS actions
       FROM report r
       LEFT JOIN users ur ON ur.alanyaID = r.reporter_id
       LEFT JOIN users ut ON ut.alanyaID = r.target_user_id
       LEFT JOIN message m ON m.msgID = r.target_msg_id
       LEFT JOIN users us ON us.alanyaID = m.senderID
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY FIELD(r.state, 'open', 'reviewing', 'actioned', 'dismissed'), r.created_at ASC
       LIMIT ?`,
      params,
    );

    res.json(rows);
  } catch (error) {
    console.error('[Admin] getReports error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/** Historique des décisions prises sur un signalement. */
const getReportActions = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT a.id, a.action, a.note, a.created_at,
              a.admin_id, u.nom AS admin_nom
       FROM report_action a
       LEFT JOIN users u ON u.alanyaID = a.admin_id
       WHERE a.report_id = ?
       ORDER BY a.created_at ASC`,
      [req.params.id],
    );
    res.json(rows);
  } catch (error) {
    console.error('[Admin] getReportActions error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * Enregistre une décision et met le signalement dans l'état correspondant.
 *
 * Les deux écritures sont dans une transaction : un état qui avance sans que la
 * décision soit tracée est exactement ce que ce chantier existe pour empêcher.
 */
const postReportAction = async (req, res) => {
  const { action, note } = req.body || {};
  const nextState = ACTIONS[String(action || '')];
  if (!nextState) {
    return res.status(400).json({ error: 'Décision inconnue', accepted: Object.keys(ACTIONS) });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[report]] = await conn.execute('SELECT id FROM report WHERE id = ?', [req.params.id]);
    if (!report) {
      await conn.rollback();
      return res.status(404).json({ error: 'Signalement introuvable' });
    }

    await conn.execute(
      `INSERT INTO report_action (report_id, admin_id, action, note)
       VALUES (?, ?, ?, ?)`,
      [report.id, req.user.alanyaID, nextState, note ? String(note).slice(0, 500) : null],
    );
    await conn.execute('UPDATE report SET state = ? WHERE id = ?', [nextState, report.id]);

    await conn.commit();
    res.json({ ok: true, state: nextState });
  } catch (error) {
    await conn.rollback();
    console.error('[Admin] postReportAction error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    conn.release();
  }
};

module.exports = { getReports, getReportActions, postReportAction, ACTIONS, STATES };
