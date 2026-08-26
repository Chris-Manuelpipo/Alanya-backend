const pool = require('../../config/db');

/**
 * Lecture du journal des actions administrateur.
 *
 * Une seule route filtrable sert les deux usages : la page « Activité admin »
 * sans filtre, et l'encart « qui a touché à ce compte » avec
 * `targetType=user&targetId=…`. Deux routes auraient divergé.
 *
 * Consultable par tout administrateur, délibérément : un journal que seul son
 * lecteur le plus puissant peut lire ne protège personne de lui.
 */

/** Filtres acceptés, et la colonne qu'ils visent. */
const FILTERS = {
  adminId: 'a.admin_id',
  action: 'a.action',
  targetType: 'a.target_type',
  targetId: 'a.target_id',
};

const getAudit = async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const where = [];
    const params = [];

    for (const [key, column] of Object.entries(FILTERS)) {
      const value = req.query[key];
      if (value == null || value === '') continue;
      where.push(`${column} = ?`);
      params.push(String(value));
    }

    // `since` borne la fenêtre plutôt que de paginer à l'infini dans le passé.
    if (req.query.since) {
      where.push('a.created_at >= ?');
      params.push(String(req.query.since));
    }

    // Curseur keyset sur l'identifiant seul : il est monotone et unique, la
    // date ne l'est pas — deux actions peuvent tomber dans la même seconde.
    const before = parseInt(req.query.before, 10);
    if (Number.isInteger(before) && before > 0) {
      where.push('a.id < ?');
      params.push(before);
    }

    params.push(limit);

    const [rows] = await pool.query(
      `SELECT a.id, a.action, a.route, a.target_type, a.target_id, a.reason,
              a.ip, a.status_code, a.created_at,
              a.admin_id, u.nom AS admin_nom, u.email AS admin_email
       FROM admin_audit a
       LEFT JOIN users u ON u.alanyaID = a.admin_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY a.id DESC
       LIMIT ?`,
      params,
    );

    res.json(rows);
  } catch (error) {
    console.error('[Admin] getAudit error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * Vocabulaire du journal : ce que les filtres peuvent proposer.
 *
 * Lu depuis la table et non depuis la carte du middleware : ce sont les actions
 * réellement enregistrées qui intéressent, `unmapped` compris.
 */
const getAuditActions = async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT action, COUNT(*) AS n, MAX(created_at) AS derniere
       FROM admin_audit GROUP BY action ORDER BY n DESC`,
    );
    res.json(rows);
  } catch (error) {
    console.error('[Admin] getAuditActions error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { getAudit, getAuditActions };
