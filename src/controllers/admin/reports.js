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

/**
 * Les jointures de la file, partagées par les trois requêtes.
 *
 * Le décompte et la recherche doivent voir exactement les mêmes lignes que la
 * page : une clause `FROM` recopiée diverge au premier ajout de colonne, et la
 * divergence se lit comme « la pagination compte faux ».
 */
const REPORTS_FROM = `
  FROM report r
  LEFT JOIN users ur ON ur.alanyaID = r.reporter_id
  LEFT JOIN users ut ON ut.alanyaID = r.target_user_id
  LEFT JOIN message m ON m.msgID = r.target_msg_id
  LEFT JOIN users us ON us.alanyaID = m.senderID`;

/**
 * Filtres de la file : état, compte visé, recherche libre.
 *
 * La recherche balaie ce qu'un modérateur a sous les yeux et retape : les noms
 * des trois comptes en présence — l'auteur du signalement, le compte visé,
 * l'auteur du message signalé — la précision laissée par le plaignant, et le
 * message lui-même. Ce dernier n'élargit rien : ces messages sont déjà servis
 * un par un dans la file, chercher dedans ne donne accès à rien de neuf.
 *
 * Huit `LIKE '%…%'`, donc aucun index utilisable. C'est assumé : une file de
 * modération se compte en milliers de lignes, et le jour où ce ne sera plus
 * vrai, c'est un index `FULLTEXT` qu'il faudra, pas une clause de plus.
 */
function buildReportsWhere(query) {
  const where = [];
  const params = [];

  const state = String(query.state || '');
  if (STATES.includes(state)) {
    where.push('r.state = ?');
    params.push(state);
  }
  if (query.targetUserId) {
    where.push('r.target_user_id = ?');
    params.push(Number(query.targetUserId));
  }

  const search = String(query.search || '').trim();
  if (search) {
    const like = `%${search}%`;
    where.push(`(ur.nom LIKE ? OR ur.pseudo LIKE ?
              OR ut.nom LIKE ? OR ut.pseudo LIKE ?
              OR us.nom LIKE ? OR us.pseudo LIKE ?
              OR r.note LIKE ? OR m.content LIKE ?)`);
    params.push(like, like, like, like, like, like, like, like);
  }

  return {
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params,
  };
}

const getReports = async (req, res) => {
  try {
    const pageN = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limitN = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (pageN - 1) * limitN;

    const { whereSql, params } = buildReportsWhere(req.query);

    // Les plus anciens d'abord parmi les ouverts : une file de modération se
    // vide par le bas, sinon les signalements du jour enterrent ceux d'hier.
    //
    // `r.id` en dernier départage les ex æquo. Sans lui, deux signalements
    // déposés dans la même seconde peuvent changer d'ordre entre deux
    // requêtes — et à la pagination, ce sont des lignes vues deux fois et
    // d'autres jamais.
    const [items] = await pool.query(
      `SELECT r.id, r.target_type, r.target_msg_id, r.target_user_id, r.reason,
              r.note, r.state, r.created_at, r.updated_at,
              r.reporter_id, ur.nom AS reporter_nom, ur.pseudo AS reporter_pseudo,
              ut.nom AS target_nom, ut.pseudo AS target_pseudo, ut.exclus AS target_exclus,
              m.senderID AS msg_sender_id, m.type AS msg_type, m.content AS msg_content,
              m.isDeleted AS msg_deleted, m.sendAt AS msg_sent_at,
              us.nom AS msg_sender_nom, us.pseudo AS msg_sender_pseudo,
              (SELECT COUNT(*) FROM report_action a WHERE a.report_id = r.id) AS actions
       ${REPORTS_FROM}
       ${whereSql}
       ORDER BY FIELD(r.state, 'open', 'reviewing', 'actioned', 'dismissed'),
                r.created_at ASC, r.id ASC
       LIMIT ${limitN} OFFSET ${offset}`,
      params,
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total ${REPORTS_FROM} ${whereSql}`,
      params,
    );

    // Le nombre d'ouverts ignore le filtre d'état mais garde la recherche : le
    // bandeau « n en attente » n'a de sens que s'il compte au-delà de l'onglet
    // affiché, et il mentirait s'il ignorait aussi la recherche en cours.
    // Calculé ici plutôt que déduit de la page : depuis la pagination, la page
    // ne contient plus qu'une tranche, et compter dessus donnerait « 20 ».
    const { whereSql: openWhere, params: openParams } = buildReportsWhere({
      ...req.query,
      state: '',
    });
    // `open_count` et non `open` : le second est un mot-clé MySQL, et un alias
    // qui heurte l'analyseur ne se voit qu'à l'exécution.
    const [[{ open_count: openCount }]] = await pool.query(
      `SELECT COUNT(*) AS open_count ${REPORTS_FROM}
       ${openWhere ? `${openWhere} AND` : 'WHERE'} r.state = 'open'`,
      openParams,
    );

    res.json({ items, total, open: openCount, page: pageN, limit: limitN });
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
