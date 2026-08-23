const GENRES = Object.freeze(['homme', 'femme', 'autre', 'non_precise']);

const FIELD_MAP = Object.freeze({
  idPays: { col: 'idPays', type: 'int' },
  idVille: { col: 'idVille', type: 'int' },
  genre: { col: 'genre', type: 'string' },
  age: { col: 'age', type: 'int' },
  account_type: { col: 'account_type', type: 'int' },
  verification_status: { col: 'verification_status', type: 'int' },
  created_at: { col: 'created_at', type: 'date' },
  // last_seen vit dans user_presence, pas `users` (audit scalabilité,
  // fractionnement par colonnes) — qualifié par `up` quel que soit l'alias
  // appelant (voir compileToSql), les appelants ajoutant le LEFT JOIN requis.
  last_seen: { col: 'last_seen', type: 'date', table: 'up' },
  verified_until: { col: 'verified_until', type: 'date' },
  alanyaID: { col: 'alanyaID', type: 'int' },
});

const MAX_CONDITIONS = 20;
const MAX_IN_IDS = 500;

const asDate = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const resolveRelativeDates = (criteria, sentAt = new Date()) => {
  const sent = asDate(sentAt) || new Date();
  const clone = JSON.parse(JSON.stringify(criteria || { v: 1, op: 'and', conditions: [] }));
  for (const cond of clone.conditions || []) {
    if (!cond.value || typeof cond.value !== 'object') continue;
    if (cond.value.relative) {
      const m = String(cond.value.relative).match(/^(-?\d+)\s*(day|days|hour|hours)$/i);
      if (m) {
        const n = Number(m[1]);
        const unit = m[2].toLowerCase().startsWith('hour') ? 'hours' : 'days';
        const d = new Date(sent);
        if (unit === 'hours') d.setHours(d.getHours() + n);
        else d.setDate(d.getDate() + n);
        cond.value = { absolute: d.toISOString() };
      }
    }
  }
  clone.resolvedAt = sent.toISOString();
  return clone;
};

const validateCriteria = (criteria) => {
  if (!criteria || criteria.v !== 1) throw new Error('Critères invalides (v=1 requis)');
  if (criteria.op !== 'and') throw new Error('Seul op=and est supporté');
  const conditions = criteria.conditions || [];
  if (conditions.length > MAX_CONDITIONS) throw new Error(`Max ${MAX_CONDITIONS} conditions`);
  for (const c of conditions) {
    if (!FIELD_MAP[c.field]) throw new Error(`Champ inconnu: ${c.field}`);
    if (c.field === 'genre' && c.value != null && !GENRES.includes(c.value)) {
      throw new Error(`Genre invalide: ${c.value}`);
    }
    if (c.op === 'in' && Array.isArray(c.value) && c.value.length > MAX_IN_IDS) {
      throw new Error(`Max ${MAX_IN_IDS} IDs`);
    }
  }
};

const compileToSql = (criteria, { sentAt = new Date(), alias = 'u' } = {}) => {
  validateCriteria(criteria);
  const parts = [];
  const params = [];

  for (const cond of criteria.conditions || []) {
    const fieldDef = FIELD_MAP[cond.field];
    const col = `${fieldDef.table || alias}.${fieldDef.col}`;
    const { op, value } = cond;

    if (op === 'eq') {
      parts.push(`${col} = ?`);
      params.push(value);
    } else if (op === 'in') {
      const arr = Array.isArray(value) ? value : [value];
      parts.push(`${col} IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    } else if (op === 'lt') {
      parts.push(`${col} < ?`);
      params.push(value);
    } else if (op === 'lte') {
      parts.push(`${col} <= ?`);
      params.push(value);
    } else if (op === 'gt') {
      parts.push(`${col} > ?`);
      params.push(value);
    } else if (op === 'gte') {
      parts.push(`${col} >= ?`);
      params.push(value);
    } else if (op === 'between') {
      parts.push(`${col} BETWEEN ? AND ?`);
      params.push(value[0], value[1]);
    } else if (op === 'before') {
      const abs = value?.absolute ? asDate(value.absolute) : asDate(value);
      parts.push(`${col} < ?`);
      params.push(abs);
    } else if (op === 'after') {
      const abs = value?.absolute ? asDate(value.absolute) : asDate(value);
      parts.push(`${col} > ?`);
      params.push(abs);
    } else {
      throw new Error(`Opérateur inconnu: ${op}`);
    }
  }

  parts.push(`${alias}.created_at <= ?`);
  params.push(asDate(sentAt));

  return {
    whereFragment: parts.join(' AND '),
    params,
  };
};

const evalCond = (user, cond, { sentAt }) => {
  const val = user[FIELD_MAP[cond.field]?.col ?? cond.field];
  const { op, value } = cond;

  if (['genre', 'age', 'idVille'].includes(cond.field) && (val == null || val === '')) {
    return false;
  }

  if (op === 'eq') return val == value;
  if (op === 'in') {
    const arr = Array.isArray(value) ? value : [value];
    return arr.some((v) => v == val);
  }
  if (op === 'lt') return val != null && val < value;
  if (op === 'lte') return val != null && val <= value;
  if (op === 'gt') return val != null && val > value;
  if (op === 'gte') return val != null && val >= value;
  if (op === 'between') return val != null && val >= value[0] && val <= value[1];
  if (op === 'before') {
    const abs = asDate(value?.absolute ?? value);
    const d = asDate(val);
    return d != null && abs != null && d < abs;
  }
  if (op === 'after') {
    const abs = asDate(value?.absolute ?? value);
    const d = asDate(val);
    return d != null && abs != null && d > abs;
  }
  return false;
};

const evaluateInMemory = (user, criteria, { sentAt = new Date() } = {}) => {
  validateCriteria(criteria);
  const created = asDate(user.created_at);
  const sent = asDate(sentAt);
  if (created && sent && created > sent) return false;
  return (criteria.conditions || []).every((c) => evalCond(user, c, { sentAt }));
};

const countAudience = async (pool, criteria, sentAt = new Date()) => {
  const resolved = resolveRelativeDates(criteria, sentAt);
  const { whereFragment, params } = compileToSql(resolved, { sentAt });
  const [[row]] = await pool.execute(
    `SELECT COUNT(*) AS n FROM users u
     LEFT JOIN user_presence up ON up.alanyaID = u.alanyaID
     WHERE ${whereFragment}`,
    params,
  );
  return { count: Number(row.n), criteria: resolved };
};

module.exports = {
  GENRES,
  FIELD_MAP,
  resolveRelativeDates,
  validateCriteria,
  compileToSql,
  evaluateInMemory,
  countAudience,
};
