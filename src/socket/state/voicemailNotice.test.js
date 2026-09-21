/**
 * Plafond quotidien du rappel « répondeur actif » : un par compte et par jour,
 * dans les deux implémentations.
 *
 * Aucune base, aucun Redis réel : le repli mémoire se teste tel quel, et la
 * branche Redis reçoit un faux client par `setDataClient`, comme le fait
 * `qrContactTokens.test.js`.
 */
const assert = require('assert');

const { setDataClient } = require('../../config/redisData');
const notice = require('./voicemailNotice');

async function main() {
  /* ══ Repli mémoire ══ */

  setDataClient(null);
  notice._resetMemory();

  assert.strictEqual(
    await notice.claimDailyNotice(42, '2026-09-21'),
    true,
    'premier appel intercepté de la journée : on notifie',
  );
  assert.strictEqual(
    await notice.claimDailyNotice(42, '2026-09-21'),
    false,
    'deuxième appel le même jour : silence',
  );
  assert.strictEqual(
    await notice.claimDailyNotice(42, '2026-09-22'),
    true,
    'le lendemain, le droit est rouvert',
  );
  assert.strictEqual(
    await notice.claimDailyNotice(43, '2026-09-21'),
    true,
    'le plafond est par compte, pas global',
  );

  // Entrées incomplètes : on ne notifie pas plutôt que de notifier à tort.
  assert.strictEqual(await notice.claimDailyNotice(null, '2026-09-21'), false);
  assert.strictEqual(await notice.claimDailyNotice(42, null), false);

  /* ══ Branche Redis ══ */

  // Faux client minimal : `SET key val NX EX` rend 'OK' si la clé était libre,
  // null sinon — exactement le contrat que le module exploite.
  const store = new Map();
  const appels = [];
  setDataClient({
    set: async (cle, valeur, options) => {
      appels.push({ cle, valeur, options });
      if (options && options.NX && store.has(cle)) return null;
      store.set(cle, valeur);
      return 'OK';
    },
  });

  assert.strictEqual(await notice.claimDailyNotice(42, '2026-09-21'), true);
  assert.strictEqual(await notice.claimDailyNotice(42, '2026-09-21'), false);
  assert.strictEqual(await notice.claimDailyNotice(42, '2026-09-22'), true);

  // La réservation doit être atomique : un GET suivi d'un SET laisserait deux
  // instances se croire toutes les deux les premières.
  assert.ok(
    appels.every((a) => a.options && a.options.NX === true),
    'toujours SET NX, jamais une lecture puis une écriture',
  );
  assert.ok(
    appels.every((a) => a.options.EX === notice.TTL_SECONDS),
    'un TTL sur chaque clé : rien à purger à la main',
  );
  // 48 h et pas 24 : une journée civile peut durer 25 heures au changement
  // d'heure, et une clé expirée trop tôt rouvrirait le droit le même jour.
  assert.ok(notice.TTL_SECONDS >= 25 * 3600, 'le TTL couvre une journée longue');

  assert.strictEqual(notice.keyOf(42, '2026-09-21'), 'alanya:voicemailNotice:42:2026-09-21');

  // Les deux implémentations comptent séparément, ce qui est sans conséquence :
  // une instance ne bascule pas de l'une à l'autre en cours de route.
  setDataClient(null);

  console.log('✓ voicemailNotice : un rappel par compte et par jour, mémoire et Redis');
}

main().catch((e) => {
  console.error('voicemailNotice.test.js ÉCHEC :', e);
  process.exit(1);
});
