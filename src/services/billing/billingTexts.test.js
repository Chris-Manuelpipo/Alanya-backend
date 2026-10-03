const assert = require('assert');
const { fmtAmount, fmtDay, graceText, graceReminderText } = require('./billingTexts');

const GRACE = new Date('2026-12-31T12:00:00Z');
const langs = ['fr', 'en', 'zh'];

// ── Le prix vient du plan, jamais du texte ─────────────────────────────────
for (const model of [1, 2]) {
  for (const fn of [graceText, graceReminderText]) {
    const a = fn({ model, graceUntil: GRACE, price: 1000 });
    const b = fn({ model, graceUntil: GRACE, price: 1500 });
    for (const l of langs) {
      assert.ok(a[l].includes(fmtAmount(1000, { fr: 'fr-FR', en: 'en-GB', zh: 'zh-CN' }[l])), `${fn.name} ${model} ${l} : 1 000 F`);
      assert.ok(b[l].includes(fmtAmount(1500, { fr: 'fr-FR', en: 'en-GB', zh: 'zh-CN' }[l])), `${fn.name} ${model} ${l} : 1 500 F`);
      assert.ok(!b[l].includes(fmtAmount(1000, { fr: 'fr-FR', en: 'en-GB', zh: 'zh-CN' }[l])),
        `${fn.name} ${model} ${l} : l'ancien prix ne reste pas écrit en dur`);
      assert.ok(a[l].length > 40);
    }
  }
}

// ── La date est celle de la grâce, dans la langue ──────────────────────────
{
  const t = graceText({ model: 2, graceUntil: GRACE, price: 1000 });
  assert.ok(t.fr.includes(fmtDay(GRACE, 'fr-FR')));
  assert.ok(t.en.includes(fmtDay(GRACE, 'en-GB')));
  assert.ok(t.zh.includes(fmtDay(GRACE, 'zh-CN')));
}

// ── Chaque régime dit ce qui le concerne ───────────────────────────────────
{
  const trial = graceText({ model: 2, graceUntil: GRACE, price: 1000 });
  const plus = graceText({ model: 1, graceUntil: GRACE, price: 1000 });
  assert.ok(/messages et vos appels/.test(trial.fr), 'essai : on reçoit toujours');
  assert.ok(/envoyer des messages et appeler/.test(trial.fr), 'essai : on n\'envoie plus');
  assert.ok(/traduction/.test(plus.fr), 'régime Alanya Plus : les fonctionnalités annexes');
  assert.ok(!/traduction/.test(trial.fr), 'essai : pas de liste de fonctionnalités annexes');
  assert.ok(!/coche/.test(trial.fr));
  const rem = graceReminderText({ model: 2, graceUntil: GRACE, price: 1000 });
  assert.ok(/7 jours/.test(rem.fr) && /7 days/.test(rem.en) && /7 天/.test(rem.zh));
}

// ── Montants ───────────────────────────────────────────────────────────────
assert.ok(/^1\s?000 F$/.test(fmtAmount(1000, 'fr-FR').replace(/[  ]/g, ' ')));
assert.strictEqual(fmtAmount(1000, 'en-GB'), '1,000 F');
assert.strictEqual(fmtAmount(999.6, 'en-GB'), '1,000 F', 'le XAF n\'a pas de sous-unité');

console.log('billingTexts.test.js OK');
