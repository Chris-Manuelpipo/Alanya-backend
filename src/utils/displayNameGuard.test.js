const assert = require('assert');
const { guardDisplayNames, isReservedBrand } = require('./displayNameGuard');
const { ACCOUNT_TYPE } = require('../constants/accountTypes');

assert.strictEqual(isReservedBrand('alanya'), true);
assert.strictEqual(isReservedBrand('alanya support'), true);

const blocked = guardDisplayNames({ nom: 'Alanya', pseudo: 'user', accountType: ACCOUNT_TYPE.PERSONNEL });
assert.strictEqual(blocked.ok, false);

const official = guardDisplayNames({
  nom: 'Alanya',
  pseudo: 'Alanya News',
  accountType: ACCOUNT_TYPE.OFFICIEL,
  allowOfficialBrandName: true,
});
assert.strictEqual(official.ok, true);

const ok = guardDisplayNames({ nom: 'Chris', pseudo: 'chris42', accountType: 0 });
assert.strictEqual(ok.ok, true);

console.log('displayNameGuard.test.js OK');
