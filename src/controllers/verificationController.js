/**
 * Dossier de vérification, côté titulaire : dépôt, suivi, compléments,
 * annulation.
 *
 * Les pièces partent directement au coffre chiffré (documentVault), jamais
 * par uploads/. Un seul dossier ouvert à la fois : la ligne `users` est
 * verrouillée le temps du contrôle et de l'insertion, deux dépôts simultanés
 * s'y sérialisent.
 */

const pool = require('../config/db');
const { fail, failInternal } = require('../utils/apiError');
const { ACCOUNT_TYPE } = require('../constants/accountTypes');
const {
  REQUEST_STATUS: R, OPEN_STATUSES, DOC_TYPE, REQUEST_STATUS_NAME,
} = require('../constants/verification');
const { vaultConfigured, storeDocument, destroyDocument } = require('../services/documentVault');
const {
  latestRequest, recomputeVerification, schedulePiecesPurge,
} = require('../services/billing/verification');
const { nameChanged } = require('../services/billing/verificationRules');
const { notifyEntitlementsChanged } = require('../services/billing/subscriptions');

const iso = (v) => (v ? new Date(v).toISOString() : null);

/** Ce que l'écran « Obtenir la coche » affiche, en un appel. */
async function verificationPayload(alanyaID) {
  const [[user]] = await pool.execute(
    'SELECT nom, account_type, verification_status, verified_until FROM users WHERE alanyaID = ?',
    [alanyaID],
  );
  const request = await latestRequest(alanyaID);
  let documents = [];
  if (request) {
    const [rows] = await pool.execute(
      `SELECT id, doc_type, mime, size_bytes, uploaded_at, purged_at
         FROM verification_document WHERE request_id = ? ORDER BY id ASC`,
      [request.id],
    );
    documents = rows.map((d) => ({
      id: d.id,
      docType: Number(d.doc_type),
      mime: d.mime,
      size: Number(d.size_bytes),
      uploadedAt: iso(d.uploaded_at),
      purged: Boolean(d.purged_at),
    }));
  }
  return {
    available: vaultConfigured(),
    currentName: user?.nom ?? '',
    verification: {
      status: Number(user?.verification_status) || 0,
      until: iso(user?.verified_until),
    },
    request: request
      ? {
        id: request.id,
        status: REQUEST_STATUS_NAME[request.status],
        claimedName: request.claimed_name,
        nameAtApproval: request.name_at_approval,
        nameChanged: Number(request.status) === R.APPROVED
          && nameChanged(request.name_at_approval, user?.nom),
        reason: Number(request.status) === R.REVOKED ? request.revoke_reason : request.reason,
        createdAt: iso(request.created_at),
        decidedAt: iso(Number(request.status) === R.REVOKED ? request.revoked_at : request.decided_at),
      }
      : null,
    documents,
  };
}

/** Les fichiers reçus par multer, rangés par type de pièce. */
function receivedPieces(req) {
  const files = req.files || {};
  return [
    ...(files.identity || []).map((f) => ({ file: f, docType: DOC_TYPE.IDENTITY })),
    ...(files.selfie || []).map((f) => ({ file: f, docType: DOC_TYPE.SELFIE })),
  ];
}

/** Chiffre et range ; en cas d'échec, rien ne reste au coffre. */
async function storePieces(pieces) {
  const stored = [];
  try {
    for (const p of pieces) {
      stored.push({ ...(await storeDocument(p.file.buffer)), docType: p.docType, mime: p.file.mimetype });
    }
    return stored;
  } catch (err) {
    await Promise.all(stored.map((s) => destroyDocument(s.storageKey).catch(() => {})));
    throw err;
  }
}

async function insertDocuments(conn, requestId, stored) {
  for (const s of stored) {
    await conn.execute(
      `INSERT INTO verification_document (request_id, doc_type, storage_key, mime, size_bytes, sha256)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [requestId, s.docType, s.storageKey, s.mime, s.size, s.sha256],
    );
  }
}

/** GET /api/verification */
const getMyVerification = async (req, res) => {
  try {
    res.json(await verificationPayload(req.user.alanyaID));
  } catch (err) {
    console.error('[verification] lecture :', err);
    return failInternal(res);
  }
};

/** POST /api/verification — multipart : identity (1 à 2 faces), selfie (1). */
const submitVerification = async (req, res) => {
  const alanyaID = req.user.alanyaID;
  if (!vaultConfigured()) {
    return fail(res, 503, 'VERIFICATION_UNAVAILABLE', 'La vérification n\'est pas encore ouverte');
  }
  const pieces = receivedPieces(req);
  if (!pieces.some((p) => p.docType === DOC_TYPE.IDENTITY) || !pieces.some((p) => p.docType === DOC_TYPE.SELFIE)) {
    return fail(res, 400, 'DOCUMENTS_REQUIRED', 'Pièce d\'identité et selfie requis');
  }

  let stored = [];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[user]] = await conn.execute(
      'SELECT nom, account_type FROM users WHERE alanyaID = ? FOR UPDATE',
      [alanyaID],
    );
    const name = String(user?.nom ?? '').trim();
    if (!name) {
      await conn.rollback();
      return fail(res, 400, 'NAME_REQUIRED', 'Renseignez votre nom avant de le faire vérifier');
    }
    const last = await latestRequest(alanyaID, conn);
    if (last && OPEN_STATUSES.includes(Number(last.status))) {
      await conn.rollback();
      return fail(res, 409, 'VERIFICATION_ALREADY_OPEN', 'Une demande est déjà en cours', { requestId: last.id });
    }
    if (last && Number(last.status) === R.APPROVED && !nameChanged(last.name_at_approval, name)) {
      await conn.rollback();
      return fail(res, 409, 'VERIFICATION_ALREADY_APPROVED', 'Votre identité est déjà vérifiée');
    }

    stored = await storePieces(pieces);
    const [ins] = await conn.execute(
      `INSERT INTO verification_request (alanyaID, target_type, claimed_name, status)
       VALUES (?, ?, ?, ?)`,
      [alanyaID, Number(user.account_type) === ACCOUNT_TYPE.BUSINESS ? 1 : 0, name.slice(0, 160), R.PENDING],
    );
    await insertDocuments(conn, ins.insertId, stored);
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    await Promise.all(stored.map((s) => destroyDocument(s.storageKey).catch(() => {})));
    console.error('[verification] dépôt :', err);
    return failInternal(res);
  } finally {
    conn.release();
  }

  await recomputeVerification(alanyaID).catch((err) => console.error('[verification] recalcul :', err.message));
  notifyEntitlementsChanged(alanyaID);
  res.status(201).json(await verificationPayload(alanyaID));
};

/** POST /api/verification/documents — compléter un dossier en « pièce demandée ». */
const addVerificationDocuments = async (req, res) => {
  const alanyaID = req.user.alanyaID;
  if (!vaultConfigured()) {
    return fail(res, 503, 'VERIFICATION_UNAVAILABLE', 'La vérification n\'est pas encore ouverte');
  }
  const pieces = receivedPieces(req);
  if (!pieces.length) return fail(res, 400, 'DOCUMENTS_REQUIRED', 'Aucune pièce reçue');

  let stored = [];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('SELECT alanyaID FROM users WHERE alanyaID = ? FOR UPDATE', [alanyaID]);
    const last = await latestRequest(alanyaID, conn);
    if (!last || Number(last.status) !== R.DOCUMENT_REQUESTED) {
      await conn.rollback();
      return fail(res, 409, 'REQUEST_NOT_PENDING', 'Aucune pièce n\'est attendue');
    }
    stored = await storePieces(pieces);
    await insertDocuments(conn, last.id, stored);
    await conn.execute(
      'UPDATE verification_request SET status = ? WHERE id = ? AND status = ?',
      [R.PENDING, last.id, R.DOCUMENT_REQUESTED],
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    await Promise.all(stored.map((s) => destroyDocument(s.storageKey).catch(() => {})));
    console.error('[verification] complément :', err);
    return failInternal(res);
  } finally {
    conn.release();
  }
  res.json(await verificationPayload(alanyaID));
};

/** DELETE /api/verification — annuler un dossier ouvert. */
const cancelVerification = async (req, res) => {
  const alanyaID = req.user.alanyaID;
  try {
    const last = await latestRequest(alanyaID);
    if (!last || !OPEN_STATUSES.includes(Number(last.status))) {
      return fail(res, 409, 'REQUEST_NOT_PENDING', 'Aucune demande en cours');
    }
    const now = new Date();
    const [upd] = await pool.execute(
      'UPDATE verification_request SET status = ?, decided_at = ? WHERE id = ? AND status IN (?, ?)',
      [R.CANCELLED, now, last.id, ...OPEN_STATUSES],
    );
    if (upd.affectedRows === 1) {
      // Abandon : rien ne justifie de garder les pièces 90 jours.
      await pool.execute(
        'UPDATE verification_document SET purge_after = ? WHERE request_id = ? AND purged_at IS NULL',
        [now, last.id],
      );
    }
    await recomputeVerification(alanyaID);
    notifyEntitlementsChanged(alanyaID);
    res.json(await verificationPayload(alanyaID));
  } catch (err) {
    console.error('[verification] annulation :', err);
    return failInternal(res);
  }
};

module.exports = {
  getMyVerification,
  submitVerification,
  addVerificationDocuments,
  cancelVerification,
  // Réutilisés par l'administration.
  schedulePiecesPurge,
};
