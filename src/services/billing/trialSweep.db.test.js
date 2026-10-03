/**
 * Le balayage de fin d'essai, contre la base.
 *
 * Exige la migration 090. Crée des comptes jetables et MODIFIE
 * `billing_settings` : il ne tourne que contre une base locale (voir
 * activationCodes.db.test.js).
 *
 *   DB_HOST=127.0.0.1 DB_PORT=3399 DB_NAME=alanya_test DB_USER=root DB_PASSWORD= \
 *     NODE_ENV=test node src/services/billing/trialSweep.db.test.js
 *
 * Les envois sont interceptés : on lit ce qui PARTIRAIT, rien ne part.
 */
const assert = require('assert');

const host = String(process.env.DB_HOST || '');
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  console.error(`trialSweep.db.test.js : refusé, DB_HOST=${host || '(vide)'} n'est pas une base locale.`);
  process.exit(2);
}

// Le .env du dépôt déclare des comptes testeurs (BILLING_TEST_USERS) : leurs
// identifiants finiraient par désigner un compte jetable de ce test. Vide, et
// posé AVANT le chargement du .env, qui n'écrase jamais une variable existante.
process.env.BILLING_TEST_USERS = '';

const pool = require('../../config/db');
const notify = require('./billingNotify');
const sent = [];
notify.pushBilling = async (alanyaID, message) => { sent.push({ alanyaID, type: message.type, title: message.title }); };
const { runTrialNotices, candidateRanges } = require('./trialSweep');
const { invalidateBillingSettings } = require('./settings');

const DAY = 86_400_000;
const comptes = [];
const NOW = new Date();

async function setSettings(fields) {
  const keys = Object.keys(fields);
  await pool.execute(
    `UPDATE billing_settings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = 1`,
    keys.map((k) => fields[k]),
  );
  invalidateBillingSettings();
}

async function compte(nom, ageJours, extra = {}) {
  const [r] = await pool.execute(
    `INSERT INTO users (nom, pseudo, alanyaPhone, password, idPays, exclus, type_compte, account_type, created_at)
     VALUES (?, ?, ?, 'test-sans-connexion', 10, 0, ?, ?, ?)`,
    [nom, nom, String(80000000 + Math.floor(Math.random() * 9999999)),
      extra.type_compte ?? 0, extra.account_type ?? 0, new Date(NOW.getTime() - ageJours * DAY)],
  );
  comptes.push(r.insertId);
  return r.insertId;
}

const prevenus = (kindTitle) => sent.filter((s) => s.title.includes(kindTitle)).map((s) => s.alanyaID).sort((a, b) => a - b);
const noticesOf = async (id) => {
  const [rows] = await pool.execute('SELECT kind FROM trial_notice WHERE alanyaID = ? ORDER BY kind', [id]);
  return rows.map((r) => Number(r.kind));
};

(async () => {
  try {
    // ── Dégrossissage des dates (pur) ──────────────────────────────────────
    {
      const s = { trial_days: 90, paid_enabled: 1, grace_until: new Date(NOW.getTime() - 30 * DAY) };
      const [a, ...rest] = candidateRanges({ settings: s, lo: NOW, hi: new Date(NOW.getTime() + 7 * DAY) });
      assert.strictEqual(rest.length, 0, 'grâce passée : un seul intervalle');
      assert.strictEqual(Math.round((NOW - a.after) / DAY), 90);
      assert.strictEqual(Math.round((NOW - a.upTo) / DAY), 83);
      const withGrace = candidateRanges({
        settings: { ...s, grace_until: new Date(NOW.getTime() + 3 * DAY) },
        lo: NOW, hi: new Date(NOW.getTime() + 7 * DAY),
      });
      assert.strictEqual(withGrace.length, 2, 'la grâce finit dans la fenêtre : on cherche aussi les comptes anciens');
      assert.strictEqual(withGrace[1].after, null);
    }

    // ── Régime 1 ou payant éteint : rien ───────────────────────────────────
    await setSettings({ model: 1, paid_enabled: 1, grace_until: new Date(NOW.getTime() - 30 * DAY), trial_days: 90 });
    const bientot = await compte('test-essai-bientot', 85.5); // fin dans 5 jours
    const fini = await compte('test-essai-fini', 100);      // fini depuis 10 jours
    const ancien = await compte('test-essai-ancien', 130);  // fini depuis 40 jours
    const recent = await compte('test-essai-recent', 20);   // loin de la fin
    const abonne = await compte('test-essai-abonne', 85);
    const equipe = await compte('test-essai-equipe', 85, { type_compte: 1 });
    const officiel = await compte('test-essai-officiel', 85, { account_type: 2 });
    await pool.execute(
      `INSERT INTO subscription_period (alanyaID, plan_id, starts_at, ends_at, source)
       SELECT ?, id, ?, ?, 4 FROM plan WHERE code = 'plus_annuel'`,
      [abonne, new Date(NOW.getTime() + 5 * DAY), new Date(NOW.getTime() + 370 * DAY)],
    );
    assert.deepStrictEqual(await runTrialNotices(NOW), { ending: 0, ended: 0 }, 'régime 1 : aucun avis');
    await setSettings({ model: 2, paid_enabled: 0 });
    assert.deepStrictEqual(await runTrialNotices(NOW), { ending: 0, ended: 0 }, 'payant éteint : aucun avis');
    assert.strictEqual(sent.length, 0);

    // ── Régime essai, payant allumé ────────────────────────────────────────
    await setSettings({ model: 2, paid_enabled: 1 });
    const r1 = await runTrialNotices(NOW);
    assert.deepStrictEqual(r1, { ending: 1, ended: 1 });
    assert.deepStrictEqual(prevenus('se termine'), [bientot], 'fin proche : le compte à 5 jours');
    assert.deepStrictEqual(prevenus('est terminé'), [fini], 'fin : le compte fini depuis 10 jours');
    assert.ok(sent.every((s) => ![ancien, recent, abonne, equipe, officiel].includes(s.alanyaID)),
      'ni trop ancien, ni trop tôt, ni abonné, ni équipe, ni officiel');
    assert.deepStrictEqual(await noticesOf(bientot), [1]);
    assert.deepStrictEqual(await noticesOf(fini), [2]);
    assert.ok(sent.find((s) => s.alanyaID === bientot).title.includes('5 jours'), sent.find((s) => s.alanyaID === bientot).title);

    // ── Rejouer : personne n'est prévenu deux fois ─────────────────────────
    assert.deepStrictEqual(await runTrialNotices(NOW), { ending: 0, ended: 0 });
    assert.deepStrictEqual(await runTrialNotices(new Date(NOW.getTime() + 3 * 3_600_000)), { ending: 0, ended: 0 });
    assert.strictEqual(sent.length, 2);

    // ── Le compte à 5 jours arrive au terme : il reçoit AUSSI l'avis de fin ─
    const r2 = await runTrialNotices(new Date(NOW.getTime() + 6 * DAY));
    assert.deepStrictEqual(r2, { ending: 0, ended: 1 });
    assert.deepStrictEqual(await noticesOf(bientot), [1, 2]);

    // ── Les comptes anciens attendent la fin de la grâce ───────────────────
    sent.length = 0;
    await setSettings({ grace_until: new Date(NOW.getTime() + 3 * DAY) });
    const vieux = await compte('test-essai-vieux', 400);
    const r3 = await runTrialNotices(NOW);
    assert.ok(prevenus('se termine').includes(vieux), 'la grâce finit dans 3 jours : avis de fin proche');
    assert.ok(!prevenus('est terminé').includes(vieux));
    assert.ok(r3.ending >= 1);
    // Leur essai a pour fin la grâce : ils ne sont PAS prévenus plus tôt.
    sent.length = 0;
    await setSettings({ grace_until: new Date(NOW.getTime() + 30 * DAY) });
    const neuf = await compte('test-essai-grace-lointaine', 400);
    await runTrialNotices(NOW);
    assert.ok(!prevenus('se termine').includes(neuf) && !prevenus('est terminé').includes(neuf),
      'grâce lointaine : rien à dire à un compte ancien');
    // La grâce est passée depuis deux jours : avis de fin.
    sent.length = 0;
    await setSettings({ grace_until: new Date(NOW.getTime() - 2 * DAY) });
    await runTrialNotices(NOW);
    assert.ok(prevenus('est terminé').includes(neuf), 'grâce finie : avis de fin pour les anciens comptes');

    console.log('trialSweep.db.test.js OK');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    try {
      if (comptes.length) await pool.query('DELETE FROM users WHERE alanyaID IN (?)', [comptes]);
    } catch (e) {
      console.error('nettoyage :', e.message);
    }
    await pool.end();
    process.exit(process.exitCode || 0);
  }
})();
