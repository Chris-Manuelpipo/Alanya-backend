/**
 * Codes d'activation : émission, rachat, révocation, liste.
 *
 * Un code naît d'un paiement confirmé sur le site (`issueActivationCode`, que le
 * site appellera) ou d'un geste de l'administration (`issueBatch`). Saisi dans
 * l'application, il donne une période d'un an (`redeemCode`), à la suite de ce
 * qui court déjà — essai compris : payer pendant l'essai ne le consomme pas.
 *
 * Le code n'est JAMAIS stocké en clair : son HMAC l'est (codeFormat.hashCode),
 * plus ses quatre derniers symboles pour le support. Il n'est donc visible
 * qu'une fois, à l'émission.
 *
 * Le rachat est une seule transaction : la ligne du code, puis celle de
 * l'abonné, sont verrouillées ; deux saisies simultanées du même code se
 * sérialisent, la seconde le trouve utilisé.
 */

const pool = require('../../config/db');
const { PERIOD_SOURCE, PHASE } = require('../../constants/billing');
const { BillingError } = require('./errors');
const { getBillingSettings } = require('./settings');
const { effectivePhase, codeSecretBlocker } = require('./rules');
const {
  appendPeriod, graceToPreserve, notifyEntitlementsChanged,
} = require('./subscriptions');
const { scheduleChainJobs } = require('./billingSchedule');
const {
  generateCode, formatCode, parseCode, hashCode, hintOf,
  attemptAfterFailure, lockRemainingSeconds,
} = require('./codeFormat');

const DAY_MS = 86_400_000;

/** `activation_code.source` */
const CODE_SOURCE = Object.freeze({ WEB: 0, ADMIN: 1 });
/** `activation_code.status` */
const CODE_STATUS = Object.freeze({ AVAILABLE: 0, REDEEMED: 1, REVOKED: 2 });

/** Un code non utilisé vaut un an à partir de son émission. */
const DEFAULT_VALIDITY_DAYS = 365;
const MAX_VALIDITY_DAYS = 730;
const MAX_BATCH = 200;

function secret() {
  const blocker = codeSecretBlocker();
  if (blocker) {
    throw new BillingError(blocker, 503, 'ACTIVATION_CODE_SECRET n\'est pas posé sur le serveur');
  }
  return process.env.ACTIVATION_CODE_SECRET;
}

/**
 * Le plan que les codes vendent : l'actif mis en avant (l'annuel), sinon le
 * plus long. Le même choix que l'abonnement offert (`grantGift`).
 */
async function getSalePlan(executor = pool) {
  const [[plan]] = await executor.execute(
    'SELECT * FROM plan WHERE is_active = 1 ORDER BY is_featured DESC, duration_months DESC, id ASC LIMIT 1',
  );
  return plan || null;
}

/** Insère un code neuf ; réessaie si deux tirages se télescopent (≈ jamais). */
async function insertCode(conn, key, plan, {
  source, orderRef = null, buyerContact = null, label = null, createdBy = null,
  amountPaid = 0, currency = null, expiresAt,
}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const canonical = generateCode();
    try {
      const [res] = await conn.execute(
        `INSERT INTO activation_code
           (code_hash, code_hint, plan_id, duration_months, amount_paid, currency, source,
            order_ref, buyer_contact, label, expires_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [hashCode(canonical, key), hintOf(canonical), plan.id, Number(plan.duration_months),
          amountPaid, currency || plan.currency, source, orderRef, buyerContact, label,
          expiresAt, createdBy],
      );
      return { id: res.insertId, code: formatCode(canonical), hint: hintOf(canonical) };
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY' && /uq_code_hash/.test(err.message)) continue;
      throw err;
    }
  }
  throw new Error('Tirage de code : collisions répétées');
}

const expiryFrom = (now, validityDays) => new Date(now.getTime() + validityDays * DAY_MS);

/**
 * Émet le code d'une commande payée sur le site. À appeler une seule fois la
 * commande confirmée par le fournisseur — mais sans danger si le webhook est
 * rejoué : `orderRef` est unique, la seconde émission ne crée rien.
 *
 * Le prix et la durée du plan sont recopiés sur le code : changer le plan plus
 * tard ne touche aucun code déjà vendu.
 *
 * @returns {Promise<{ created: boolean, id: number, code: string|null, hint: string }>}
 *   `code` est le texte en clair à la création seulement ; une réémission
 *   rejouée rend `created: false` et `code: null` — le site a déjà montré et
 *   envoyé le premier, il ne peut pas le redemander.
 */
async function issueActivationCode({
  planId = null, amountPaid, currency = null, orderRef, buyerContact = null,
  validityDays = DEFAULT_VALIDITY_DAYS, now = new Date(),
}) {
  if (typeof orderRef !== 'string' || !orderRef.trim() || orderRef.length > 120) {
    throw new BillingError('INVALID_CODE_ORDER', 400, 'orderRef est obligatoire (120 caractères au plus)');
  }
  if (!Number.isInteger(amountPaid) || amountPaid < 0) {
    throw new BillingError('INVALID_CODE_ORDER', 400, 'amountPaid doit être un entier positif ou nul');
  }
  const key = secret();
  const [[existing]] = await pool.execute(
    'SELECT id, code_hint FROM activation_code WHERE order_ref = ?', [orderRef],
  );
  if (existing) return { created: false, id: existing.id, code: null, hint: existing.code_hint };

  let plan;
  if (planId != null) {
    [[plan]] = await pool.execute('SELECT * FROM plan WHERE id = ?', [planId]);
  } else {
    plan = await getSalePlan();
  }
  if (!plan) throw new BillingError('PLAN_NOT_FOUND', 404, 'Aucun plan à vendre');

  try {
    const made = await insertCode(pool, key, plan, {
      source: CODE_SOURCE.WEB, orderRef, buyerContact, amountPaid, currency,
      expiresAt: expiryFrom(now, validityDays),
    });
    return { created: true, ...made };
  } catch (err) {
    // Deux appels simultanés pour la même commande : l'un a gagné.
    if (err.code === 'ER_DUP_ENTRY' && /uq_code_order/.test(err.message)) {
      const [[row]] = await pool.execute(
        'SELECT id, code_hint FROM activation_code WHERE order_ref = ?', [orderRef],
      );
      return { created: false, id: row?.id ?? null, code: null, hint: row?.code_hint ?? null };
    }
    throw err;
  }
}

/**
 * Un lot de codes générés par l'administration (tests, ventes manuelles). Tous
 * ou aucun : une seule transaction.
 *
 * @returns {Promise<Array<{ id: number, code: string, hint: string }>>}
 */
async function issueBatch({
  count, label = null, adminId, validityDays = DEFAULT_VALIDITY_DAYS, amountPaid = 0,
  now = new Date(),
}) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH) {
    throw new BillingError('INVALID_CODE_BATCH', 400, `count : entier entre 1 et ${MAX_BATCH}`);
  }
  if (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > MAX_VALIDITY_DAYS) {
    throw new BillingError('INVALID_CODE_BATCH', 400, `validity_days : entier entre 1 et ${MAX_VALIDITY_DAYS}`);
  }
  if (!Number.isInteger(amountPaid) || amountPaid < 0) {
    throw new BillingError('INVALID_CODE_BATCH', 400, 'amount_paid : entier positif ou nul');
  }
  const cleanLabel = label == null ? null : String(label).trim().slice(0, 120) || null;
  const key = secret();
  const plan = await getSalePlan();
  if (!plan) throw new BillingError('PLAN_NOT_FOUND', 404, 'Aucun plan actif à vendre');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const made = [];
    for (let i = 0; i < count; i++) {
      made.push(await insertCode(conn, key, plan, {
        source: CODE_SOURCE.ADMIN, label: cleanLabel, createdBy: adminId, amountPaid,
        expiresAt: expiryFrom(now, validityDays),
      }));
    }
    await conn.commit();
    return made;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ── Tentatives de saisie ────────────────────────────────────────────────

async function assertNotLocked(alanyaID, now) {
  const [[row]] = await pool.execute(
    'SELECT locked_until FROM code_attempt WHERE alanyaID = ?', [alanyaID],
  );
  const remaining = lockRemainingSeconds(row?.locked_until, now);
  if (remaining > 0) {
    throw new BillingError('CODE_LOCKED', 429, 'Trop d\'essais, réessayez plus tard', {
      retryAfterSeconds: remaining,
    });
  }
}

/** Un échec de plus, sous verrou de ligne : deux saisies parallèles ne se perdent pas. */
async function recordFailure(alanyaID, now) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      'INSERT IGNORE INTO code_attempt (alanyaID, failures, window_start) VALUES (?, 0, ?)',
      [alanyaID, now],
    );
    const [[row]] = await conn.execute(
      'SELECT failures, window_start, locked_until FROM code_attempt WHERE alanyaID = ? FOR UPDATE',
      [alanyaID],
    );
    // Une ligne neuve (0 échec) repart de un.
    const next = attemptAfterFailure(Number(row.failures) === 0 ? null : row, now);
    await conn.execute(
      'UPDATE code_attempt SET failures = ?, window_start = ?, locked_until = ? WHERE alanyaID = ?',
      [next.failures, next.windowStart, next.lockedUntil, alanyaID],
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    console.error(`[codes] échec de saisie de ${alanyaID} non enregistré :`, err.message);
  } finally {
    conn.release();
  }
}

// ── Rachat ──────────────────────────────────────────────────────────────

/**
 * Active un code pour un compte.
 *
 * Seul `INVALID_CODE` (code inconnu) compte comme un échec : un code qui existe
 * mais est utilisé, expiré ou révoqué ne donne rien à deviner. Une saisie
 * bien formée dont le contrôle échoue (faute de frappe) ne compte pas non plus,
 * elle ne peut pas réussir.
 *
 * Rejouable par le même compte : une réponse perdue en route, une seconde
 * saisie — le code déjà activé PAR CE COMPTE rend le même succès, sans
 * seconde période.
 *
 * @returns {Promise<{ startsAt: Date, endsAt: Date, alreadyApplied: boolean }>}
 */
async function redeemCode({ alanyaID, rawCode, now = new Date() }) {
  const settings = await getBillingSettings();
  // Hors phase payante, l'offre n'est pas en vente : un code acheté trop tôt
  // ferait démarrer l'année avant que l'essai des comptes ne soit posé.
  if (effectivePhase(settings, alanyaID, now) === PHASE.FREE) {
    throw new BillingError('BILLING_NOT_ACTIVE', 409, 'L\'offre n\'est pas encore proposée');
  }

  const parsed = parseCode(rawCode);
  if (!parsed.ok) {
    throw new BillingError('INVALID_CODE_FORMAT', 400, 'Code mal saisi');
  }
  await assertNotLocked(alanyaID, now);
  const hash = hashCode(parsed.canonical, secret());

  const graceUntil = await graceToPreserve(now);
  const conn = await pool.getConnection();
  let outcome;
  let plan;
  try {
    await conn.beginTransaction();
    const [[code]] = await conn.execute(
      'SELECT * FROM activation_code WHERE code_hash = ? FOR UPDATE', [hash],
    );
    if (!code) throw new BillingError('INVALID_CODE', 404, 'Code inconnu');

    if (Number(code.status) === CODE_STATUS.REDEEMED) {
      if (Number(code.redeemed_by) !== Number(alanyaID)) {
        throw new BillingError('CODE_ALREADY_USED', 409, 'Ce code a déjà été utilisé');
      }
      const [[period]] = await conn.execute(
        'SELECT starts_at, ends_at FROM subscription_period WHERE id = ?', [code.period_id],
      );
      await conn.commit();
      return {
        startsAt: period?.starts_at ?? null,
        endsAt: period?.ends_at ?? null,
        alreadyApplied: true,
      };
    }
    if (Number(code.status) === CODE_STATUS.REVOKED) {
      throw new BillingError('CODE_REVOKED', 410, 'Ce code a été annulé');
    }
    if (new Date(code.expires_at) <= now) {
      throw new BillingError('CODE_EXPIRED', 410, 'Ce code a expiré');
    }

    [[plan]] = await conn.execute('SELECT * FROM plan WHERE id = ?', [code.plan_id]);
    const appended = await appendPeriod(conn, {
      alanyaID, plan, now, graceUntil, source: PERIOD_SOURCE.CODE,
      months: Number(code.duration_months), reason: `code:${code.id}`,
    });
    const [marked] = await conn.execute(
      `UPDATE activation_code
          SET status = ?, redeemed_by = ?, redeemed_at = ?, period_id = ?
        WHERE id = ? AND status = ?`,
      [CODE_STATUS.REDEEMED, alanyaID, now, appended.periodId, code.id, CODE_STATUS.AVAILABLE],
    );
    // Verrou tenu : cela ne peut pas arriver. Si cela arrive, rien ne doit être posé.
    if (marked.affectedRows !== 1) throw new Error('Code déjà marqué sous verrou');
    await conn.execute('DELETE FROM code_attempt WHERE alanyaID = ?', [alanyaID]);
    await conn.commit();
    outcome = appended;
  } catch (err) {
    await conn.rollback();
    if (err instanceof BillingError && err.code === 'INVALID_CODE') {
      await recordFailure(alanyaID, now);
    }
    throw err;
  } finally {
    conn.release();
  }

  try {
    await scheduleChainJobs(alanyaID, outcome.end, Number(plan.reminder_days), now);
  } catch (err) {
    // Le balayage rattrapera l'échéance ; la période, elle, est acquise.
    console.error(`[codes] jobs d'échéance de ${alanyaID} :`, err.message);
  }
  notifyEntitlementsChanged(alanyaID);
  return { startsAt: outcome.start, endsAt: outcome.end, alreadyApplied: false };
}

// ── Administration ──────────────────────────────────────────────────────

/** Statut vu de l'administration : « expiré » se déduit, il n'est pas écrit. */
function viewStatus(row, now = new Date()) {
  const status = Number(row.status);
  if (status === CODE_STATUS.REDEEMED) return 'redeemed';
  if (status === CODE_STATUS.REVOKED) return 'revoked';
  return new Date(row.expires_at) <= now ? 'expired' : 'available';
}

const toRow = (r, now) => ({
  id: Number(r.id),
  hint: r.code_hint,
  status: viewStatus(r, now),
  label: r.label,
  source: Number(r.source) === CODE_SOURCE.WEB ? 'web' : 'admin',
  planCode: r.plan_code,
  durationMonths: Number(r.duration_months),
  amountPaid: Number(r.amount_paid),
  currency: r.currency,
  orderRef: r.order_ref,
  buyerContact: r.buyer_contact,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  redeemedBy: r.redeemed_by == null ? null : Number(r.redeemed_by),
  redeemedByName: r.redeemed_by_name ?? null,
  redeemedAt: r.redeemed_at,
  revokedAt: r.revoked_at,
  revokeReason: r.revoke_reason,
});

/**
 * @param {{ status?: 'available'|'redeemed'|'revoked'|'expired', search?: string,
 *           limit?: number, offset?: number }} q
 */
async function listCodes({ status = null, search = null, limit = 50, offset = 0, now = new Date() } = {}) {
  const where = [];
  const params = [];
  if (status === 'available') { where.push('c.status = ? AND c.expires_at > ?'); params.push(CODE_STATUS.AVAILABLE, now); }
  else if (status === 'expired') { where.push('c.status = ? AND c.expires_at <= ?'); params.push(CODE_STATUS.AVAILABLE, now); }
  else if (status === 'redeemed') { where.push('c.status = ?'); params.push(CODE_STATUS.REDEEMED); }
  else if (status === 'revoked') { where.push('c.status = ?'); params.push(CODE_STATUS.REVOKED); }
  else if (status != null) throw new BillingError('INVALID_CODE_FILTER', 400, 'status invalide');

  const term = typeof search === 'string' ? search.trim().slice(0, 80) : '';
  if (term) {
    const like = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
    where.push('(c.code_hint LIKE ? OR c.label LIKE ? OR c.order_ref LIKE ? OR c.buyer_contact LIKE ? OR u.nom LIKE ?)');
    params.push(like, like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);

  const from = `FROM activation_code c
                  JOIN plan p ON p.id = c.plan_id
                  LEFT JOIN users u ON u.alanyaID = c.redeemed_by`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} ${clause}`, params);
  const [rows] = await pool.query(
    `SELECT c.*, p.code AS plan_code, u.nom AS redeemed_by_name
       ${from} ${clause}
      ORDER BY c.id DESC LIMIT ? OFFSET ?`,
    [...params, lim, off],
  );
  return { total: Number(total), rows: rows.map((r) => toRow(r, now)) };
}

/**
 * Annule un code encore disponible. Un code déjà activé ne s'annule pas : sa
 * période est acquise, et la retirer relève d'un autre geste.
 */
async function revokeCode({ id, adminId, reason, now = new Date() }) {
  const cleanReason = typeof reason === 'string' ? reason.trim().slice(0, 255) : '';
  if (cleanReason.length < 3) throw new BillingError('REASON_REQUIRED', 400, 'Motif obligatoire');
  const [res] = await pool.execute(
    `UPDATE activation_code
        SET status = ?, revoked_by = ?, revoked_at = ?, revoke_reason = ?
      WHERE id = ? AND status = ?`,
    [CODE_STATUS.REVOKED, adminId, now, cleanReason, id, CODE_STATUS.AVAILABLE],
  );
  if (res.affectedRows === 1) return;
  const [[row]] = await pool.execute('SELECT status FROM activation_code WHERE id = ?', [id]);
  if (!row) throw new BillingError('CODE_NOT_FOUND', 404, 'Code introuvable');
  throw new BillingError(
    Number(row.status) === CODE_STATUS.REDEEMED ? 'CODE_ALREADY_USED' : 'CODE_REVOKED',
    409,
    Number(row.status) === CODE_STATUS.REDEEMED ? 'Code déjà utilisé' : 'Code déjà annulé',
  );
}

module.exports = {
  CODE_SOURCE,
  CODE_STATUS,
  DEFAULT_VALIDITY_DAYS,
  MAX_BATCH,
  getSalePlan,
  issueActivationCode,
  issueBatch,
  redeemCode,
  listCodes,
  revokeCode,
};
