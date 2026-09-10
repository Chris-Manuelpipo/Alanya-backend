/**
 * La coche : la seule écriture de `users.verification_status` et
 * `users.verified_until` (volet 8, « Une seule écriture »).
 *
 * Appelée à chaque événement qui peut la changer : décision sur un dossier,
 * dépôt, annulation, changement de nom, et tout ce qui change les droits
 * (paiement, échéance, abonnement offert, compensation — par
 * `notifyEntitlementsChanged`), plus un recalcul général aux transitions de
 * l'interrupteur et à la fin de la grâce. La règle vit dans
 * verificationRules.js ; ici on rassemble les faits.
 */

const pool = require('../../config/db');
const { REQUEST_STATUS: R, DOC_RETENTION_DAYS } = require('../../constants/verification');
const { entitlementsOrNull } = require('./entitlements');
const { decideVerification, sameVerification } = require('./verificationRules');
const { destroyDocument } = require('../documentVault');

const DAY_MS = 86_400_000;

/** Le dernier dossier du compte, hors dossiers annulés. */
async function latestRequest(alanyaID, db = pool) {
  const [[row]] = await db.execute(
    `SELECT * FROM verification_request
      WHERE alanyaID = ? AND status <> ?
      ORDER BY id DESC LIMIT 1`,
    [alanyaID, R.CANCELLED],
  );
  return row || null;
}

/**
 * Recalcule et écrit la coche d'un compte. Ne touche la ligne que si quelque
 * chose change.
 *
 * @returns {Promise<{ status: number, until: Date|null, changed: boolean }|null>}
 */
async function recomputeVerification(alanyaID, db = pool) {
  const [[user]] = await db.execute(
    'SELECT nom, verification_status, verified_until FROM users WHERE alanyaID = ?',
    [alanyaID],
  );
  if (!user) return null;
  const request = await latestRequest(alanyaID, db);
  const entitlements = await entitlementsOrNull(alanyaID);
  const next = decideVerification({ request, currentName: user.nom, entitlements });
  const current = { status: user.verification_status, until: user.verified_until };
  if (sameVerification(current, next)) return { ...next, changed: false };

  await db.execute(
    'UPDATE users SET verification_status = ?, verified_until = ? WHERE alanyaID = ?',
    [next.status, next.until, alanyaID],
  );
  // L'identité de l'expéditeur voyage dans le payload temps réel des messages,
  // servie depuis un cache : la coche doit y changer en même temps.
  try {
    require('../../utils/senderIdentityCache').invalidateSenderIdentity(alanyaID);
  } catch {
    // Sans cache (tests), rien à invalider.
  }
  return { ...next, changed: true };
}

/**
 * Tous les dossiers approuvés, par lots : la phase a changé (activation,
 * désactivation, fin de grâce), donc l'échéance de chaque coche aussi.
 */
async function recomputeAllVerifications({ batch = 500 } = {}) {
  let after = 0;
  let changed = 0;
  let seen = 0;
  for (;;) {
    const [rows] = await pool.execute(
      `SELECT DISTINCT alanyaID FROM verification_request
        WHERE status = ? AND alanyaID > ?
        ORDER BY alanyaID ASC LIMIT ${Number(batch)}`,
      [R.APPROVED, after],
    );
    if (!rows.length) break;
    for (const { alanyaID } of rows) {
      try {
        const r = await recomputeVerification(alanyaID);
        if (r?.changed) changed++;
      } catch (err) {
        console.error(`[verification] recalcul de ${alanyaID} :`, err.message);
      }
    }
    seen += rows.length;
    after = rows[rows.length - 1].alanyaID;
  }
  if (changed) console.log(`[verification] recalcul général : ${changed}/${seen} coche(s) changée(s)`);
  return { seen, changed };
}

/** Pose l'échéance de destruction des pièces d'un dossier décidé. */
async function schedulePiecesPurge(requestId, decidedAt = new Date(), db = pool) {
  await db.execute(
    `UPDATE verification_document SET purge_after = ?
      WHERE request_id = ? AND purged_at IS NULL AND purge_after IS NULL`,
    [new Date(decidedAt.getTime() + DOC_RETENTION_DAYS * DAY_MS), requestId],
  );
}

/**
 * Détruit les pièces échues. La ligne survit, marquée : elle atteste qu'une
 * pièce a existé et qu'elle a été détruite.
 */
async function purgeDueDocuments(now = new Date()) {
  const [rows] = await pool.execute(
    `SELECT id, storage_key FROM verification_document
      WHERE purge_after IS NOT NULL AND purge_after <= ? AND purged_at IS NULL
      LIMIT 200`,
    [now],
  );
  let destroyed = 0;
  for (const row of rows) {
    try {
      await destroyDocument(row.storage_key);
      await pool.execute('UPDATE verification_document SET purged_at = ? WHERE id = ?', [now, row.id]);
      destroyed++;
    } catch (err) {
      console.error(`[verification] destruction de la pièce ${row.id} :`, err.message);
    }
  }
  if (destroyed) console.log(`[verification] ${destroyed} pièce(s) détruite(s)`);
  return { destroyed };
}

module.exports = {
  latestRequest,
  recomputeVerification,
  recomputeAllVerifications,
  schedulePiecesPurge,
  purgeDueDocuments,
};
