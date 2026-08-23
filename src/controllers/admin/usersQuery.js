/** Filtres et tri partagés entre GET /users et GET /users/export. */

const ALLOWED_SORT = { created_at: 'u.created_at', nom: 'u.nom', last_seen: 'up.last_seen' };

function buildUsersWhere(query) {
  const {
    search = '',
    status = '',
    from = '',
    to = '',
    idPays = '',
  } = query;

  const where = [];
  const params = [];

  if (search) {
    where.push('(u.nom LIKE ? OR u.pseudo LIKE ? OR u.alanyaPhone LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  if (status === 'online') { where.push('up.is_online = ?'); params.push(1); }
  if (status === 'banned') { where.push('u.exclus = ?'); params.push(1); }
  if (status === 'admin') { where.push('u.type_compte >= ?'); params.push(1); }
  if (query.account_type != null && query.account_type !== '') {
    where.push('u.account_type = ?');
    params.push(Number(query.account_type));
  }
  if (from) { where.push('u.created_at >= ?'); params.push(from); }
  if (to) { where.push('u.created_at <= ?'); params.push(to); }
  if (idPays) { where.push('u.idPays = ?'); params.push(idPays); }

  const sort = query.sort || 'created_at';
  const order = query.order || 'desc';
  const sortCol = ALLOWED_SORT[sort] || ALLOWED_SORT.created_at;
  const dir = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return { whereSql, params, sortCol, dir };
}

/** `all` ou vide → pas de plafond ; sinon entier positif. */
function parseExportLimit(limitParam) {
  if (limitParam == null || limitParam === '' || String(limitParam).toLowerCase() === 'all') {
    return null;
  }
  const n = parseInt(limitParam, 10);
  if (Number.isNaN(n) || n <= 0) return null;
  return n;
}

const USERS_SELECT = `
  SELECT u.alanyaID, u.nom, u.pseudo, u.alanyaPhone, u.email, u.avatar_url,
         u.type_compte, u.account_type, u.verification_status, u.verified_until,
         up.is_online AS is_online, up.last_seen AS last_seen, u.exclus, u.exclude_at,
         u.exclude_reason, u.created_at, u.idPays, p.libelle AS pays_libelle
  FROM users u
  LEFT JOIN pays p ON u.idPays = p.idPays
  LEFT JOIN user_presence up ON up.alanyaID = u.alanyaID
`;

async function fetchUsersForExport(pool, query, exportLimit) {
  const { whereSql, params, sortCol, dir } = buildUsersWhere(query);

  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM users u
     LEFT JOIN user_presence up ON up.alanyaID = u.alanyaID
     ${whereSql}`,
    params,
  );

  const limitClause = exportLimit != null ? `LIMIT ${exportLimit}` : '';
  const [items] = await pool.execute(
    `${USERS_SELECT}
     ${whereSql}
     ORDER BY ${sortCol} ${dir}
     ${limitClause}`,
    params,
  );

  return { items, total, exported: items.length };
}

module.exports = {
  buildUsersWhere,
  parseExportLimit,
  fetchUsersForExport,
  ALLOWED_SORT,
};
