/** Filtres et tri partagés pour GET /admin/broadcasts. */

const ALLOWED_SORT = { sent_at: 'b.sent_at', estimate: 'b.estimate' };
const ACTIVE_STATUSES = ['preparing', 'queued', 'running'];
const ALLOWED_STATUS = new Set(['preparing', 'queued', 'running', 'completed', 'partial_failed', 'active']);

function buildBroadcastWhere(query) {
  const {
    search = '',
    q = '',
    kind = '',
    type = '',
    status = '',
    from = '',
    to = '',
    idPays = '',
  } = query;

  const where = [];
  const params = [];

  const term = String(search || q).trim();
  if (term) {
    where.push('(b.content LIKE ? OR b.content_en LIKE ?)');
    const like = `%${term}%`;
    params.push(like, like);
  }

  if (kind !== '' && kind != null) {
    where.push('b.kind = ?');
    params.push(Number(kind));
  }

  if (type !== '' && type != null) {
    where.push('b.type = ?');
    params.push(Number(type));
  }

  if (status === 'active') {
    where.push(`b.status IN (${ACTIVE_STATUSES.map(() => '?').join(', ')})`);
    params.push(...ACTIVE_STATUSES);
  } else if (status && ALLOWED_STATUS.has(String(status))) {
    where.push('b.status = ?');
    params.push(String(status));
  }

  if (from) {
    where.push('b.sent_at >= ?');
    params.push(from);
  }
  if (to) {
    where.push('b.sent_at <= ?');
    params.push(to);
  }

  if (idPays !== '' && idPays != null) {
    const paysId = Number(idPays);
    where.push(`EXISTS (
      SELECT 1
      FROM JSON_TABLE(
        b.criteria,
        '$.conditions[*]' COLUMNS (
          field VARCHAR(32) PATH '$.field',
          op VARCHAR(16) PATH '$.op',
          val JSON PATH '$.value'
        )
      ) AS jt
      WHERE jt.field = 'idPays'
        AND (
          (jt.op = 'eq' AND CAST(JSON_UNQUOTE(jt.val) AS UNSIGNED) = ?)
          OR (jt.op = 'in' AND JSON_CONTAINS(jt.val, CAST(? AS JSON), '$'))
        )
    )`);
    params.push(paysId, paysId);
  }

  const sort = query.sort || 'sent_at';
  const order = query.order || 'desc';
  const sortCol = ALLOWED_SORT[sort] || ALLOWED_SORT.sent_at;
  const dir = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return { whereSql, params, sortCol, dir };
}

module.exports = {
  buildBroadcastWhere,
  ALLOWED_SORT,
};
