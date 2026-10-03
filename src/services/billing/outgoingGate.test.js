const assert = require('assert');
const { createOutgoingGate } = require('./outgoingGate');

const DAY = 86_400_000;
const T0 = new Date('2026-10-03T10:00:00Z');
let nowMs = T0.getTime();
const clock = () => new Date(nowMs);
const day = (n) => new Date(T0.getTime() + n * DAY);

const TRIAL_ON = { model: 2, paid_enabled: 1, grace_until: day(-30), trial_days: 90 };

function build({ settings = TRIAL_ON, account, env = {} } = {}) {
  const calls = { settings: 0, account: 0 };
  const state = { account };
  const gate = createOutgoingGate({
    getSettings: async () => { calls.settings++; return settings; },
    loadAccount: async () => { calls.account++; return state.account; },
    clock,
    env,
  });
  return { gate, calls, state };
}

(async () => {
  // ── Hors régime essai : jamais de lecture du compte ──────────────────────
  for (const settings of [
    { ...TRIAL_ON, model: 1 },
    { ...TRIAL_ON, paid_enabled: 0 },
    { ...TRIAL_ON, grace_until: day(10) },
  ]) {
    const { gate, calls } = build({ settings, account: null });
    assert.deepStrictEqual(await gate.checkOutgoing(7), { allowed: true });
    assert.strictEqual(calls.account, 0, 'régime 1, payant éteint ou grâce : aucune lecture');
  }

  // ── Essai fini, aucun abonnement : refus, puis refus en cache ────────────
  {
    const { gate, calls } = build({ account: { created_at: day(-200), type_compte: 0, account_type: 0, covered_until: null } });
    assert.deepStrictEqual(await gate.checkOutgoing(7), { allowed: false });
    assert.deepStrictEqual(await gate.checkOutgoing(7), { allowed: false });
    assert.strictEqual(calls.account, 1, 'le refus est retenu');
    nowMs += 6_000;
    await gate.checkOutgoing(7);
    assert.strictEqual(calls.account, 2, 'un refus ne dure que 5 secondes');
    nowMs = T0.getTime();
  }

  // ── Code activé : l'invalidation rouvre tout de suite ────────────────────
  {
    const { gate, calls, state } = build({ account: { created_at: day(-200), type_compte: 0, account_type: 0, covered_until: null } });
    assert.strictEqual((await gate.checkOutgoing(7)).allowed, false);
    state.account = { ...state.account, covered_until: day(365) };
    gate.invalidateOutgoing(7);
    assert.strictEqual((await gate.checkOutgoing(7)).allowed, true);
    assert.strictEqual(calls.account, 2);
  }

  // ── Un oui est retenu une minute au plus ─────────────────────────────────
  {
    const { gate, calls } = build({ account: { created_at: day(-200), type_compte: 0, account_type: 0, covered_until: day(300) } });
    assert.strictEqual((await gate.checkOutgoing(7)).allowed, true);
    nowMs += 59_000;
    await gate.checkOutgoing(7);
    assert.strictEqual(calls.account, 1);
    nowMs += 2_000;
    await gate.checkOutgoing(7);
    assert.strictEqual(calls.account, 2, 'relu après une minute');
    nowMs = T0.getTime();
  }

  // ── Un oui ne dépasse pas sa frontière : la fin d'essai ──────────────────
  {
    // Fin d'essai dans 30 secondes : le oui expire à ce moment, pas une minute plus tard.
    const created = new Date(T0.getTime() - 90 * DAY + 30_000);
    const { gate, calls } = build({ account: { created_at: created, type_compte: 0, account_type: 0, covered_until: null } });
    assert.strictEqual((await gate.checkOutgoing(7)).allowed, true, 'en essai');
    nowMs += 29_000;
    assert.strictEqual((await gate.checkOutgoing(7)).allowed, true);
    assert.strictEqual(calls.account, 1);
    nowMs += 2_000; // l'essai est fini depuis une seconde
    assert.strictEqual((await gate.checkOutgoing(7)).allowed, false, 'refusé dès la fin d\'essai');
    assert.strictEqual(calls.account, 2);
    nowMs = T0.getTime();
  }

  // ── Fin de période : même frontière ──────────────────────────────────────
  {
    const { gate } = build({ account: { created_at: day(-200), type_compte: 0, account_type: 0, covered_until: new Date(T0.getTime() + 20_000) } });
    assert.strictEqual((await gate.checkOutgoing(7)).allowed, true);
    nowMs += 21_000;
    assert.strictEqual((await gate.checkOutgoing(7)).allowed, false, 'la période a pris fin, plus personne pour couvrir');
    nowMs = T0.getTime();
  }

  // ── Équipe et compte officiel : jamais soumis ────────────────────────────
  for (const account of [
    { created_at: day(-200), type_compte: 1, account_type: 0, covered_until: null },
    { created_at: day(-200), type_compte: 0, account_type: 2, covered_until: null },
  ]) {
    const { gate } = build({ account });
    assert.strictEqual((await gate.checkOutgoing(7)).allowed, true,
      `exempté : type_compte=${account.type_compte} account_type=${account.account_type}`);
  }

  // ── Compte introuvable ou base en panne : ouvert ─────────────────────────
  {
    const { gate } = build({ account: null });
    assert.strictEqual((await gate.checkOutgoing(7)).allowed, true, 'compte introuvable');
    const down = createOutgoingGate({
      getSettings: async () => TRIAL_ON,
      loadAccount: async () => { const e = new Error('boom'); e.code = 'ECONNREFUSED'; throw e; },
      clock,
    });
    assert.strictEqual((await down.checkOutgoing(7)).allowed, true, 'panne de base : le verrou s\'ouvre');
    assert.strictEqual(down.cacheSize(), 0, 'une panne ne s\'inscrit pas en cache');
  }

  // ── Compte testeur : phase payante même payant éteint, sans grâce ────────
  {
    const off = { ...TRIAL_ON, paid_enabled: 0, grace_until: null };
    const { gate } = build({
      settings: off,
      env: { BILLING_TEST_USERS: '7' },
      account: { created_at: day(-200), type_compte: 0, account_type: 0, covered_until: null },
    });
    assert.strictEqual((await gate.checkOutgoing(7)).allowed, false, 'le testeur subit le verrou');
    assert.strictEqual((await gate.checkOutgoing(8)).allowed, true, 'un autre compte, non');
    // Sa grâce, si le payant est allumé, ne le protège pas : comme dans ses droits.
    const on = build({
      settings: { ...TRIAL_ON, grace_until: day(10) },
      env: { BILLING_TEST_USERS: '7' },
      account: { created_at: day(-200), type_compte: 0, account_type: 0, covered_until: null },
    });
    assert.strictEqual((await on.gate.checkOutgoing(7)).allowed, false);
    assert.strictEqual((await on.gate.checkOutgoing(8)).allowed, true, 'grâce : tout le monde sauf le testeur');
  }

  // ── Le cache est borné ───────────────────────────────────────────────────
  {
    const { gate } = build({ account: { created_at: day(-200), type_compte: 0, account_type: 0, covered_until: null } });
    for (let i = 1; i <= 3; i++) await gate.checkOutgoing(i);
    assert.strictEqual(gate.cacheSize(), 3);
    gate.clearOutgoingCache();
    assert.strictEqual(gate.cacheSize(), 0);
  }

  console.log('outgoingGate.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
