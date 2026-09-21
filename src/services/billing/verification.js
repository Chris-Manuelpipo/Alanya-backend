/**
 * La coche : la seule écriture de `users.verification_status` et
 * `users.verified_until`.
 *
 * Pour les comptes personnels, elle suit l'abonnement (périodes avec
 * `grants_badge`) et une éventuelle révocation admin. Les comptes business
 * et officiels ne sont pas touchés ici — leur badge se résout ailleurs.
 *
 * Appelée à chaque événement qui peut la changer : paiement, échéance,
 * abonnement offert, compensation, révocation, et les transitions de
 * l'interrupteur (via `recomputeAllVerifications`).
 */

const pool = require('../../config/db');
const { ACCOUNT_TYPE } = require('../../constants/accountTypes');
const { DOC_RETENTION_DAYS } = require('../../constants/verification');
const { entitlementsOrNull } = require('./entitlements');
const { decideBadge, sameVerification } = require('./verificationRules');
const { destroyDocument } = require('../documentVault');

const DAY_MS = 86_400_000;

/** Le dernier dossier du compte, hors dossiers annulés (réservé au business). */
async function latestRequest(alanyaID, db = pool) {
  const { REQUEST_STATUS: R } = require('../../constants/verification');
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
 * chose change. Les comptes non personnels sont laissés tels quels.
 *
 * @returns {Promise<{ status: number, until: Date|null, changed: boolean }|null>}
 */
async function recomputeVerification(alanyaID, db = pool) {
  const [[user]] = await db.execute(
    'SELECT account_type, type_compte, verification_status, verified_until FROM users WHERE alanyaID = ?',
    [alanyaID],
  );
  if (!user) return null;

  // Business, officiel, équipe : panier / sceau doré / rien — on n'écrit pas
  // la coche indigo automatiquement.
  if (Number(user.account_type) !== ACCOUNT_TYPE.PERSONNEL || Number(user.type_compte) >= 1) {
    return {
      status: Number(user.verification_status) || 0,
      until: user.verified_until ? new Date(user.verified_until) : null,
      changed: false,
    };
  }

  const [[revocation]] = await db.execute(
    'SELECT alanyaID FROM badge_revocation WHERE alanyaID = ?',
    [alanyaID],
  );
  const entitlements = await entitlementsOrNull(alanyaID);
  const now = new Date();

  // Droits indisponibles : on ne retire pas une coche faute de réponse.
  if (!entitlements && !revocation) {
    return {
      status: Number(user.verification_status) || 0,
      until: user.verified_until ? new Date(user.verified_until) : null,
      changed: false,
    };
  }

  const [grantingPeriods] = await db.execute(
    `SELECT starts_at, ends_at FROM subscription_period
      WHERE alanyaID = ? AND grants_badge = 1 AND ends_at > ?
      ORDER BY starts_at ASC LIMIT 24`,
    [alanyaID, now],
  );
  const [[sub]] = await db.execute(
    'SELECT current_end FROM subscriber WHERE alanyaID = ?',
    [alanyaID],
  );

  const next = decideBadge({
    revoked: Boolean(revocation),
    accountType: ACCOUNT_TYPE.PERSONNEL,
    typeCompte: Number(user.type_compte) || 0,
    phase: entitlements?.phase ?? 'free',
    grantingPeriods,
    lastEnd: sub?.current_end ?? null,
    now,
  });
  if (next == null) return null;

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
 * Tous les abonnés et tous les comptes dont la coche est posée, par lots :
 * la phase a changé, ou une échéance collective doit tout recalculer.
 */
async function recomputeAllVerifications({ batch = 500 } = {}) {
  let after = 0;
  let changed = 0;
  let seen = 0;
  for (;;) {
    // Abonnés (période ou non) + comptes personnels déjà marqués vérifiés /
    // expirés / révoqués, pour ne laisser personne avec une coche orpheline.
    const [rows] = await pool.execute(
      `SELECT DISTINCT u.alanyaID FROM users u
        LEFT JOIN subscriber s ON s.alanyaID = u.alanyaID
       WHERE u.account_type = ?
         AND u.alanyaID > ?
         AND (s.alanyaID IS NOT NULL OR u.verification_status IN (2, 4, 5))
       ORDER BY u.alanyaID ASC LIMIT ${Number(batch)}`,
      [ACCOUNT_TYPE.PERSONNEL, after],
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
