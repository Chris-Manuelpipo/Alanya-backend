/**
 * Balayage de la fin d'essai : prévient, une fois, chaque compte dont l'essai
 * gratuit va finir (dans les sept jours) ou vient de finir (depuis moins de
 * quatorze jours) et qui n'a aucun abonnement. Régime essai seulement, payant
 * allumé : ailleurs, personne n'a d'essai qui finisse.
 *
 * L'essai ne se stocke pas, il se déduit (rules.js `trialEndsAt`) : le balayage
 * cherche donc par date d'inscription. La requête dégrossit, la règle pure
 * `trialNoticeFor` tranche — une requête trop large n'envoie jamais un mauvais
 * message.
 *
 * Une notification ne part qu'une fois par compte et par type : la clé primaire
 * de `trial_notice` est la trace durable, écrite AVANT l'envoi (un job réussi,
 * lui, disparaît de la file, il ne peut pas servir de mémoire). Un envoi perdu
 * est un message de moins, jamais un message en double.
 */

const pool = require('../../config/db');
const { ACCOUNT_TYPE } = require('../../constants/accountTypes');
const { BILLING_MODEL, PHASE, TRIAL_NOTICE } = require('../../constants/billing');
const { withLease } = require('../schedulerLease');
const { getBillingSettings } = require('./settings');
const {
  DAY_MS, billingModel, phaseAt, trialEndsAt, trialNoticeFor,
  TRIAL_ENDING_DAYS, TRIAL_ENDED_GRACE_DAYS,
} = require('./rules');
const { pushBilling, messages } = require('./billingNotify');

const INTERVAL_MS = 15 * 60_000;
const BATCH = 500;
const MAX_PAGES = 4;
let timer = null;
let first = null;

/**
 * Intervalles de dates d'inscription où peut se trouver un compte dont la fin
 * d'essai tombe dans ]lo, hi].
 *
 * Fin d'essai = max(inscription + essai, fin de grâce). Deux cas : la fin vient
 * de l'inscription (au-delà de la grâce), ou de la grâce (les comptes plus
 * anciens, qui l'attendent tous).
 *
 * @returns {Array<{ after: Date|null, upTo: Date }>} inscription dans ]after, upTo]
 */
function candidateRanges({ settings, lo, hi }) {
  const trial = (Number(settings.trial_days) || 0) * DAY_MS;
  const grace = Number(settings.paid_enabled) === 1 && settings.grace_until
    ? new Date(settings.grace_until)
    : null;
  const ranges = [];
  const natural = {
    after: new Date(Math.max(lo.getTime(), grace ? grace.getTime() : -Infinity) - trial),
    upTo: new Date(hi.getTime() - trial),
  };
  if (natural.after < natural.upTo) ranges.push(natural);
  if (grace && grace > lo && grace <= hi) {
    ranges.push({ after: null, upTo: new Date(grace.getTime() - trial) });
  }
  return ranges;
}

async function candidates({ kind, lo, hi, settings, now }) {
  const seen = new Map();
  for (const range of candidateRanges({ settings, lo, hi })) {
    let cursor = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const [rows] = await pool.query(
        `SELECT u.alanyaID, u.created_at
           FROM users u
          WHERE u.exclus = 0 AND u.type_compte = 0 AND u.account_type <> ?
            AND u.alanyaID > ?
            ${range.after ? 'AND u.created_at > ?' : ''}
            AND u.created_at <= ?
            AND NOT EXISTS (SELECT 1 FROM subscription_period sp
                             WHERE sp.alanyaID = u.alanyaID AND sp.ends_at > ?)
            AND NOT EXISTS (SELECT 1 FROM trial_notice n
                             WHERE n.alanyaID = u.alanyaID AND n.kind = ?)
          ORDER BY u.alanyaID ASC LIMIT ?`,
        [
          ACCOUNT_TYPE.OFFICIEL, cursor,
          ...(range.after ? [range.after] : []),
          range.upTo, now, kind, BATCH,
        ],
      );
      for (const r of rows) seen.set(r.alanyaID, r);
      if (rows.length < BATCH) break;
      cursor = rows[rows.length - 1].alanyaID;
    }
  }
  return [...seen.values()];
}

/**
 * Un passage. Rend ce qu'il a envoyé. Rejouable à volonté : un compte déjà
 * prévenu n'est plus candidat.
 *
 * @returns {Promise<{ ending: number, ended: number }>}
 */
async function runTrialNotices(now = new Date()) {
  const settings = await getBillingSettings();
  const sent = { ending: 0, ended: 0 };
  if (billingModel(settings) !== BILLING_MODEL.TRIAL || phaseAt(settings, now) === PHASE.FREE) return sent;

  const plan = [
    { name: 'ending', kind: TRIAL_NOTICE.ENDING, lo: now, hi: new Date(now.getTime() + TRIAL_ENDING_DAYS * DAY_MS) },
    { name: 'ended', kind: TRIAL_NOTICE.ENDED, lo: new Date(now.getTime() - TRIAL_ENDED_GRACE_DAYS * DAY_MS), hi: now },
  ];
  for (const { name, kind, lo, hi } of plan) {
    for (const row of await candidates({ kind, lo, hi, settings, now })) {
      const endsAt = trialEndsAt({ createdAt: row.created_at, settings });
      if (trialNoticeFor({ endsAt, now }) !== name) continue;
      // La trace d'abord : si deux balayages se croisent, un seul l'écrit.
      const [res] = await pool.execute(
        'INSERT IGNORE INTO trial_notice (alanyaID, kind) VALUES (?, ?)', [row.alanyaID, kind],
      );
      if (res.affectedRows !== 1) continue;
      const daysLeft = Math.max(1, Math.ceil((endsAt.getTime() - now.getTime()) / DAY_MS));
      await pushBilling(
        row.alanyaID,
        name === 'ending' ? messages.trialEnding({ daysLeft, endsAt }) : messages.trialEnded(),
      );
      sent[name]++;
    }
  }
  return sent;
}

async function tick() {
  try {
    await withLease('trial_sweep', async () => {
      const sent = await runTrialNotices();
      if (sent.ending || sent.ended) {
        console.log(`[billing] fin d'essai : ${sent.ending} avis de fin proche, ${sent.ended} avis de fin`);
      }
    }, 600);
  } catch (err) {
    console.error('[billing] balayage de fin d\'essai :', err.message);
  }
}

function startTrialSweep() {
  if (timer) return;
  timer = setInterval(tick, INTERVAL_MS);
  first = setTimeout(tick, 60_000);
}

function stopTrialSweep() {
  if (timer) clearInterval(timer);
  if (first) clearTimeout(first);
  timer = null;
  first = null;
}

module.exports = {
  runTrialNotices,
  candidateRanges,
  startTrialSweep,
  stopTrialSweep,
};
