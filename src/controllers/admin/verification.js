/**
 * Instruction des dossiers de vérification (volet 5, révisé par le volet 8).
 *
 * Tout administrateur instruit ; l'auteur de chaque décision est tracé sur le
 * dossier, et `adminAudit` recopie le verbe et le motif. Chaque ouverture de
 * pièce écrit une ligne dans `verification_document_access` : des pièces
 * d'identité consultables sans trace ne protègent personne.
 */

const pool = require('../../config/db');
const { fail, failInternal } = require('../../utils/apiError');
const { REQUEST_STATUS: R, OPEN_STATUSES, REQUEST_STATUS_NAME } = require('../../constants/verification');
const { readDocument } = require('../../services/documentVault');
const {
  recomputeVerification, schedulePiecesPurge,
} = require('../../services/billing/verification');
const { nameChanged } = require('../../services/billing/verificationRules');
const { parseReason } = require('../../services/billing/rules');
const { notifyEntitlementsChanged } = require('../../services/billing/subscriptions');
const { pushBilling, messages } = require('../../services/billing/billingNotify');

const iso = (v) => (v ? new Date(v).toISOString() : null);
const limitOf = (raw, max = 200) => Math.min(max, Math.max(1, parseInt(raw, 10) || 50));
const idOf = (raw) => {
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/** Files de travail. `renamed` : approuvés dont le nom affiché a changé depuis. */
const QUEUES = {
  pending: { where: 'r.status = ?', params: [R.PENDING], order: 'r.created_at ASC' },
  documents: { where: 'r.status = ?', params: [R.DOCUMENT_REQUESTED], order: 'r.updated_at DESC' },
  renamed: {
    where: 'r.status = ? AND r.name_at_approval IS NOT NULL AND r.name_at_approval <> u.nom',
    params: [R.APPROVED],
    order: 'r.decided_at ASC',
  },
  decided: { where: 'r.status IN (?, ?, ?)', params: [R.APPROVED, R.REFUSED, R.REVOKED], order: 'r.decided_at DESC' },
  all: { where: '1 = 1', params: [], order: 'r.id DESC' },
};

const rowOut = (r) => ({
  id: r.id,
  alanya_id: r.alanyaID,
  user_name: r.nom,
  pseudo: r.pseudo,
  avatar_url: r.avatar_url,
  account_type: Number(r.account_type),
  target_type: Number(r.target_type),
  claimed_name: r.claimed_name,
  name_at_approval: r.name_at_approval,
  name_changed: Number(r.status) === R.APPROVED && nameChanged(r.name_at_approval, r.nom),
  status: REQUEST_STATUS_NAME[r.status],
  reason: r.reason,
  revoke_reason: r.revoke_reason,
  reviewer_name: r.reviewer_name ?? null,
  documents: Number(r.documents ?? 0),
  created_at: iso(r.created_at),
  decided_at: iso(r.decided_at),
  revoked_at: iso(r.revoked_at),
});

const BASE_SELECT = `
  SELECT r.*, u.nom, u.pseudo, u.avatar_url, u.account_type,
         rv.nom AS reviewer_name,
         (SELECT COUNT(*) FROM verification_document d WHERE d.request_id = r.id) AS documents
    FROM verification_request r
    JOIN users u ON u.alanyaID = r.alanyaID
    LEFT JOIN users rv ON rv.alanyaID = r.reviewed_by`;

/** GET /admin/verifications?queue=pending|documents|renamed|decided|all */
const listVerifications = async (req, res) => {
  const queue = QUEUES[String(req.query.queue || 'pending')] || QUEUES.pending;
  try {
    const [rows] = await pool.execute(
      `${BASE_SELECT} WHERE ${queue.where} ORDER BY ${queue.order} LIMIT ${limitOf(req.query.limit)}`,
      queue.params,
    );
    res.json({ requests: rows.map(rowOut) });
  } catch (err) {
    console.error('[admin/verification] file :', err);
    return failInternal(res);
  }
};

/** GET /admin/verifications/count — le compteur du menu. */
const countVerifications = async (req, res) => {
  try {
    const [[row]] = await pool.execute(
      `SELECT
         SUM(r.status = ?) AS pending,
         SUM(r.status = ?) AS documents,
         SUM(r.status = ? AND r.name_at_approval IS NOT NULL AND r.name_at_approval <> u.nom) AS renamed
       FROM verification_request r JOIN users u ON u.alanyaID = r.alanyaID`,
      [R.PENDING, R.DOCUMENT_REQUESTED, R.APPROVED],
    );
    res.json({
      pending: Number(row?.pending) || 0,
      documents: Number(row?.documents) || 0,
      renamed: Number(row?.renamed) || 0,
    });
  } catch (err) {
    console.error('[admin/verification] compteur :', err);
    return failInternal(res);
  }
};

async function detailPayload(id) {
  const [[r]] = await pool.execute(`${BASE_SELECT} WHERE r.id = ?`, [id]);
  if (!r) return null;
  const [[user]] = await pool.execute(
    `SELECT alanyaID, nom, pseudo, avatar_url, alanyaPhone, account_type,
            verification_status, verified_until, created_at
       FROM users WHERE alanyaID = ?`,
    [r.alanyaID],
  );
  const [docs] = await pool.execute(
    `SELECT d.id, d.doc_type, d.mime, d.size_bytes, d.uploaded_at, d.purge_after, d.purged_at,
            (SELECT COUNT(*) FROM verification_document_access a WHERE a.document_id = d.id) AS views
       FROM verification_document d WHERE d.request_id = ? ORDER BY d.id ASC`,
    [id],
  );
  const [history] = await pool.execute(
    `${BASE_SELECT} WHERE r.alanyaID = ? AND r.id <> ? ORDER BY r.id DESC LIMIT 10`,
    [r.alanyaID, id],
  );
  return {
    request: rowOut(r),
    user: user && {
      alanya_id: user.alanyaID,
      nom: user.nom,
      pseudo: user.pseudo,
      avatar_url: user.avatar_url,
      alanya_phone: user.alanyaPhone,
      account_type: Number(user.account_type),
      verification_status: Number(user.verification_status),
      verified_until: iso(user.verified_until),
      created_at: iso(user.created_at),
    },
    documents: docs.map((d) => ({
      id: d.id,
      doc_type: Number(d.doc_type),
      mime: d.mime,
      size: Number(d.size_bytes),
      uploaded_at: iso(d.uploaded_at),
      purge_after: iso(d.purge_after),
      purged: Boolean(d.purged_at),
      views: Number(d.views) || 0,
    })),
    history: history.map(rowOut),
  };
}

/** GET /admin/verifications/:id */
const getVerification = async (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return fail(res, 404, 'VERIFICATION_NOT_FOUND', 'Dossier introuvable');
  try {
    const payload = await detailPayload(id);
    if (!payload) return fail(res, 404, 'VERIFICATION_NOT_FOUND', 'Dossier introuvable');
    res.json(payload);
  } catch (err) {
    console.error('[admin/verification] dossier :', err);
    return failInternal(res);
  }
};

/**
 * GET /admin/verifications/documents/:docId — la pièce déchiffrée, jamais
 * mise en cache. La consultation est journalisée AVANT l'envoi : une pièce
 * lue sans ligne de journal ne doit pas pouvoir exister.
 */
const getVerificationDocument = async (req, res) => {
  const id = idOf(req.params.docId);
  if (!id) return fail(res, 404, 'DOCUMENT_NOT_FOUND', 'Pièce introuvable');
  try {
    const [[doc]] = await pool.execute(
      'SELECT id, storage_key, mime, purged_at FROM verification_document WHERE id = ?',
      [id],
    );
    if (!doc) return fail(res, 404, 'DOCUMENT_NOT_FOUND', 'Pièce introuvable');
    if (doc.purged_at) return fail(res, 410, 'DOCUMENT_PURGED', 'Pièce détruite après la décision');
    await pool.execute(
      'INSERT INTO verification_document_access (document_id, admin_id, ip) VALUES (?, ?, ?)',
      [doc.id, req.user.alanyaID, String(req.ip || '').slice(0, 45) || null],
    );
    const plain = await readDocument(doc.storage_key);
    res.set({
      'Content-Type': doc.mime,
      'Cache-Control': 'no-store, private',
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(plain);
  } catch (err) {
    console.error('[admin/verification] pièce :', err.message);
    return failInternal(res);
  }
};

/**
 * Décision : met à jour le dossier si son statut le permet, recalcule la
 * coche, prévient le titulaire. Répond le dossier à jour.
 */
async function decide(req, res, { allowed, apply, notify, tag }) {
  const id = idOf(req.params.id);
  if (!id) return fail(res, 404, 'VERIFICATION_NOT_FOUND', 'Dossier introuvable');
  try {
    const [[r]] = await pool.execute(
      'SELECT r.*, u.nom FROM verification_request r JOIN users u ON u.alanyaID = r.alanyaID WHERE r.id = ?',
      [id],
    );
    if (!r) return fail(res, 404, 'VERIFICATION_NOT_FOUND', 'Dossier introuvable');
    if (!allowed(r)) return fail(res, 409, 'REQUEST_NOT_PENDING', 'Ce dossier n\'est pas dans un état qui permet cette décision');
    const now = new Date();
    const changed = await apply(r, now);
    if (!changed) return fail(res, 409, 'REQUEST_NOT_PENDING', 'Le dossier vient de changer ; rechargez-le');
    await recomputeVerification(r.alanyaID);
    notifyEntitlementsChanged(r.alanyaID);
    if (notify) await pushBilling(r.alanyaID, notify(r));
    res.json(await detailPayload(id));
  } catch (err) {
    console.error(`[admin/verification] ${tag} :`, err);
    return failInternal(res);
  }
}

const isOpen = (r) => OPEN_STATUSES.includes(Number(r.status));

/** POST /admin/verifications/:id/approve */
const approveVerification = (req, res) => decide(req, res, {
  tag: 'approbation',
  allowed: isOpen,
  apply: async (r, now) => {
    const [u] = await pool.execute(
      `UPDATE verification_request
          SET status = ?, reviewed_by = ?, decided_at = ?, name_at_approval = ?, reason = NULL
        WHERE id = ? AND status IN (?, ?)`,
      [R.APPROVED, req.user.alanyaID, now, String(r.nom ?? '').slice(0, 160), r.id, ...OPEN_STATUSES],
    );
    if (u.affectedRows !== 1) return false;
    await schedulePiecesPurge(r.id, now);
    return true;
  },
  notify: () => messages.verificationApproved(),
});

/** POST /admin/verifications/:id/refuse — { reason } */
const refuseVerification = (req, res) => {
  const reason = parseReason(req.body);
  if (!reason.ok) return fail(res, 400, reason.code, reason.error);
  return decide(req, res, {
    tag: 'refus',
    allowed: isOpen,
    apply: async (r, now) => {
      const [u] = await pool.execute(
        `UPDATE verification_request SET status = ?, reviewed_by = ?, decided_at = ?, reason = ?
          WHERE id = ? AND status IN (?, ?)`,
        [R.REFUSED, req.user.alanyaID, now, reason.value.slice(0, 255), r.id, ...OPEN_STATUSES],
      );
      if (u.affectedRows !== 1) return false;
      await schedulePiecesPurge(r.id, now);
      return true;
    },
    notify: () => messages.verificationRefused({ reason: reason.value }),
  });
};

/** POST /admin/verifications/:id/request-document — { reason } : ce qui manque. */
const requestVerificationDocument = (req, res) => {
  const reason = parseReason(req.body);
  if (!reason.ok) return fail(res, 400, reason.code, reason.error);
  return decide(req, res, {
    tag: 'pièce demandée',
    allowed: (r) => Number(r.status) === R.PENDING,
    apply: async (r) => {
      const [u] = await pool.execute(
        'UPDATE verification_request SET status = ?, reviewed_by = ?, reason = ? WHERE id = ? AND status = ?',
        [R.DOCUMENT_REQUESTED, req.user.alanyaID, reason.value.slice(0, 255), r.id, R.PENDING],
      );
      return u.affectedRows === 1;
    },
    notify: () => messages.verificationDocumentRequested({ reason: reason.value }),
  });
};

/** POST /admin/verifications/:id/revoke — { reason } : retirer une coche accordée. */
const revokeVerification = (req, res) => {
  const reason = parseReason(req.body);
  if (!reason.ok) return fail(res, 400, reason.code, reason.error);
  return decide(req, res, {
    tag: 'révocation',
    allowed: (r) => Number(r.status) === R.APPROVED,
    apply: async (r, now) => {
      const [u] = await pool.execute(
        `UPDATE verification_request SET status = ?, revoked_by = ?, revoked_at = ?, revoke_reason = ?
          WHERE id = ? AND status = ?`,
        [R.REVOKED, req.user.alanyaID, now, reason.value.slice(0, 255), r.id, R.APPROVED],
      );
      return u.affectedRows === 1;
    },
    notify: () => messages.verificationRevoked({ reason: reason.value }),
  });
};

/**
 * POST /admin/verifications/:id/reconfirm — le nom affiché a changé depuis
 * l'approbation ; l'administrateur a vérifié qu'il correspond à la pièce.
 */
const reconfirmVerification = (req, res) => decide(req, res, {
  tag: 'nouvel examen',
  allowed: (r) => Number(r.status) === R.APPROVED && nameChanged(r.name_at_approval, r.nom),
  apply: async (r, now) => {
    const [u] = await pool.execute(
      `UPDATE verification_request SET name_at_approval = ?, reviewed_by = ?, decided_at = ?
        WHERE id = ? AND status = ?`,
      [String(r.nom ?? '').slice(0, 160), req.user.alanyaID, now, r.id, R.APPROVED],
    );
    return u.affectedRows === 1;
  },
  notify: () => messages.verificationApproved(),
});

module.exports = {
  listVerifications,
  countVerifications,
  getVerification,
  getVerificationDocument,
  approveVerification,
  refuseVerification,
  requestVerificationDocument,
  revokeVerification,
  reconfirmVerification,
};
