/**
 * Balayage de l'abonnement, toutes les cinq minutes, sous le bail
 * `billing_sweep` (une seule instance à la fois).
 *
 * - À chaque passage : la réconciliation des paiements restés sans réponse.
 * - Une fois par heure : le rattrapage des échéances (expirations et purges
 *   dont le job s'est perdu). C'est le filet des jobs posés à l'heure dite,
 *   sur le patron du verificationScheduler.
 */

const { withLease } = require('../schedulerLease');
const { reconcilePending } = require('../payments/paymentService');
const { catchUpDue } = require('./billingJobs');
const { purgeDueDocuments } = require('./verification');

const INTERVAL_MS = 5 * 60_000;
const CATCH_UP_EVERY_MS = 60 * 60_000;
let timer = null;
let first = null;
let lastCatchUp = 0;

async function tick() {
  try {
    await withLease('billing_sweep', async () => {
      const r = await reconcilePending();
      if (r.settled) console.log(`[billing] réconciliation : ${r.settled}/${r.examined} paiement(s) réglé(s)`);
      if (Date.now() - lastCatchUp >= CATCH_UP_EVERY_MS) {
        lastCatchUp = Date.now();
        const c = await catchUpDue();
        if (c.expired || c.purged) {
          console.log(`[billing] rattrapage : ${c.expired} échéance(s), ${c.purged} purge(s) examinée(s)`);
        }
        // Pièces d'identité : détruites 90 jours après la décision.
        await purgeDueDocuments().catch((err) => console.error('[verification] purge des pièces :', err.message));
      }
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
