/**
 * Balayage de l'abonnement, toutes les cinq minutes, sous le bail
 * `billing_sweep` (une seule instance à la fois).
 *
 * Aujourd'hui : la réconciliation des paiements restés sans réponse. Les
 * échéances (relance, expiration, purge) s'y ajouteront, en filet des jobs
 * posés à l'heure dite.
 */

const { withLease } = require('../schedulerLease');
const { reconcilePending } = require('../payments/paymentService');

const INTERVAL_MS = 5 * 60_000;
let timer = null;
let first = null;

async function tick() {
  try {
    await withLease('billing_sweep', async () => {
      const r = await reconcilePending();
      if (r.settled) console.log(`[billing] réconciliation : ${r.settled}/${r.examined} paiement(s) réglé(s)`);
    }, 240);
  } catch (err) {
    console.error('[billing] balayage :', err.message);
  }
}

function startBillingSweep() {
  if (timer) return;
  timer = setInterval(tick, INTERVAL_MS);
  // Premier passage peu après le démarrage : un paiement resté en attente
  // pendant un redéploiement ne doit pas attendre cinq minutes de plus.
  first = setTimeout(tick, 30_000);
}

function stopBillingSweep() {
  if (timer) clearInterval(timer);
  if (first) clearTimeout(first);
  timer = null;
  first = null;
}

module.exports = { startBillingSweep, stopBillingSweep };
