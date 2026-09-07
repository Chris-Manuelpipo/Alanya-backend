const pool = require('../../config/db');

/**
 * Lecture du journal des délivrances de clé de sauvegarde.
 *
 * Séparé de `/admin/audit` parce que les deux journaux n'ont pas la même
 * nature : `admin_audit` recense des gestes rares et délibérés d'administrateur,
 * celui-ci une opération de routine que chaque inscrit déclenche à chaque
 * sauvegarde. Les mêler noierait le premier sous le second.
 *
 * Même permission cependant — `audit.read` : c'est le même métier, celui de
 * constater. Créer une permission de plus aurait imposé de reprendre les rôles
 * pour ne rien exprimer de nouveau.
 */

const getBackupKeyAccess = async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const where = [];
    const params = [];

    const alanyaId = parseInt(req.query.alanyaId, 10);
    if (Number.isInteger(alanyaId) && alanyaId > 0) {
      where.push('k.alanya_id = ?');
      params.push(alanyaId);
    }

    // `refusee` seul : la question la plus utile de cet écran. Une série de
    // refus signale un secret mal déployé bien avant que les inscrits ne se
    // plaignent de sauvegardes qui échouent.
    if (req.query.outcome) {
      where.push('k.outcome = ?');
      params.push(String(req.query.outcome));
    }

    if (req.query.since) {
      where.push('k.created_at >= ?');
      params.push(String(req.query.since));
    }

    // Curseur keyset sur l'identifiant : il est monotone et unique, la date ne
    // l'est pas — deux délivrances peuvent tomber dans la même seconde.
    const before = parseInt(req.query.before, 10);
    if (Number.isInteger(before) && before > 0) {
      where.push('k.id < ?');
      params.push(before);
    }

    params.push(limit);

    const [rows] = await pool.query(
      `SELECT k.id, k.alanya_id, k.kid, k.outcome, k.reason,
              k.ip, k.device_id, k.user_agent, k.created_at,
              u.nom AS compte_nom, u.alanyaPhone AS compte_phone
       FROM backup_key_access k
       LEFT JOIN users u ON u.alanyaID = k.alanya_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY k.id DESC
       LIMIT ?`,
      params,
    );

    res.json(rows);
  } catch (error) {
    console.error('[Admin] getBackupKeyAccess error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * Vue d'ensemble : volume, refus, comptes distincts sur la fenêtre demandée.
 *
 * Un écran qui n'affiche qu'une liste ne répond pas à la seule question qui
 * vaille au quotidien — « est-ce que quelque chose sort de l'ordinaire ? ».
 */
const getBackupKeyAccessSummary = async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
    const [rows] = await pool.query(
      `SELECT COUNT(*)                                        AS total,
              SUM(outcome = 'refusee')                        AS refus,
              COUNT(DISTINCT alanya_id)                       AS comptes,
              COUNT(DISTINCT ip)                              AS adresses,
              MAX(created_at)                                 AS derniere
       FROM backup_key_access
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [days],
    );
    const r = rows[0] || {};
    res.json({
      days,
      total: Number(r.total) || 0,
      refus: Number(r.refus) || 0,
      comptes: Number(r.comptes) || 0,
      adresses: Number(r.adresses) || 0,
      derniere: r.derniere ?? null,
    });
  } catch (error) {
    console.error('[Admin] getBackupKeyAccessSummary error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { getBackupKeyAccess, getBackupKeyAccessSummary };
