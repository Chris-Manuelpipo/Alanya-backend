const assert = require('assert');
const { OFFICIAL_IDENTITY } = require('./officialAccount');
const { guardDisplayNames, isReservedBrand, normalizeForGuard } =
  require('../../utils/displayNameGuard');
const { ACCOUNT_TYPE } = require('../../constants/accountTypes');
const { validate } = require('../../utils/alanyaPhone');

// ── L'identité imposée doit rester créable ──────────────────────────
// Le garde des noms réserve « Alanya » à tout le monde SAUF au compte officiel.
// Si quelqu'un modifie OFFICIAL_BRAND d'un côté sans l'autre, la création
// échoue en 500 sans que rien ne l'ait signalé avant la production.
const guard = guardDisplayNames({
  nom: OFFICIAL_IDENTITY.nom,
  pseudo: OFFICIAL_IDENTITY.pseudo,
  accountType: ACCOUNT_TYPE.OFFICIEL,
  allowOfficialBrandName: true,
});
assert.strictEqual(guard.ok, true, 'l\'identité officielle doit passer le garde des noms');

// ── … et rester interdite à tous les autres ─────────────────────────
const usurpation = guardDisplayNames({
  nom: OFFICIAL_IDENTITY.nom,
  pseudo: 'quelquun',
  accountType: ACCOUNT_TYPE.PERSONNEL,
});
assert.strictEqual(usurpation.ok, false);
assert.strictEqual(usurpation.code, 'RESERVED_BRAND_NAME');

assert.strictEqual(isReservedBrand(normalizeForGuard(OFFICIAL_IDENTITY.nom)), true);

// ── Le numéro doit rester au palier 3 ───────────────────────────────
// C'est ce palier, et lui seul, qui dispense d'une adresse e-mail dans
// createUser. Passer le compte officiel à 4 ou 8 chiffres rendrait l'e-mail
// obligatoire et rouvrirait une voie de récupération sur un compte qui ne doit
// pas être connectable.
const phone = validate(OFFICIAL_IDENTITY.alanyaPhone);
assert.strictEqual(phone.ok, true);
assert.strictEqual(phone.tier, 3, 'le compte officiel doit garder un numéro à 3 chiffres');

// ── Le genre est bien celui du socle ────────────────────────────────
assert.strictEqual(ACCOUNT_TYPE.OFFICIEL, 2);

console.log('officialAccount.test.js OK');
