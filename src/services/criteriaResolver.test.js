const assert = require('assert');
const {
  compileToSql,
  evaluateInMemory,
  resolveRelativeDates,
  GENRES,
} = require('./criteriaResolver');

const sampleUsers = [
  {
    alanyaID: 1,
    idPays: 5,
    idVille: 10,
    genre: 'femme',
    age: 19,
    account_type: 0,
    verification_status: 0,
    created_at: new Date('2024-01-01'),
    last_seen: new Date('2026-08-01'),
    verified_until: null,
  },
  {
    alanyaID: 2,
    idPays: 5,
    idVille: 11,
    genre: 'homme',
    age: 30,
    account_type: 1,
    verification_status: 2,
    created_at: new Date('2023-06-01'),
    last_seen: new Date('2026-07-01'),
    verified_until: new Date('2027-01-01'),
  },
  {
    alanyaID: 3,
    idPays: 7,
    idVille: null,
    genre: null,
    age: null,
    account_type: 0,
    verification_status: 0,
    created_at: new Date('2026-09-01'),
    last_seen: null,
    verified_until: null,
  },
];

const catalog = [
  {
    name: 'pays eq',
    criteria: { v: 1, op: 'and', conditions: [{ field: 'idPays', op: 'eq', value: 5 }] },
  },
  {
    name: 'femmes lte 20',
    criteria: {
      v: 1,
      op: 'and',
      conditions: [
        { field: 'genre', op: 'eq', value: 'femme' },
        { field: 'age', op: 'lte', value: 20 },
      ],
    },
  },
  {
    name: 'business verified',
    criteria: {
      v: 1,
      op: 'and',
      conditions: [
        { field: 'account_type', op: 'eq', value: 1 },
        { field: 'verification_status', op: 'eq', value: 2 },
      ],
    },
  },
];

const sentAt = new Date('2026-08-04T12:00:00Z');

for (const { name, criteria } of catalog) {
  const resolved = resolveRelativeDates(criteria, sentAt);
  const { whereFragment, params } = compileToSql(resolved, { sentAt });
  for (const user of sampleUsers) {
    const mem = evaluateInMemory(user, resolved, { sentAt });
    const sqlMatch = evalUserAgainstWhere(user, whereFragment, params);
    assert.strictEqual(mem, sqlMatch, `${name} user ${user.alanyaID}`);
  }
}

assert.throws(() => compileToSql({
  v: 1,
  op: 'and',
  conditions: [{ field: 'password', op: 'eq', value: 'x' }],
}));

assert.ok(GENRES.includes('non_precise'));

function evalUserAgainstWhere(user, whereFragment, params) {
  let pi = 0;
  const next = () => params[pi++];
  const parts = whereFragment.split(' AND ').map((p) => p.trim());
  return parts.every((part) => {
    if (part.includes('idPays = ?')) return user.idPays === next();
    if (part.includes('genre = ?')) return user.genre === next();
    if (part.includes('age <= ?')) return user.age != null && user.age <= next();
    if (part.includes('account_type = ?')) return user.account_type === next();
    if (part.includes('verification_status = ?')) return user.verification_status === next();
    if (part.includes('created_at <= ?')) {
      next();
      return user.created_at <= sentAt;
    }
    return true;
  });
}

console.log('criteriaResolver.test.js OK');
