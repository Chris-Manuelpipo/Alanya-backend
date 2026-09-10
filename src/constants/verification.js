/**
 * Dossier de vérification d'identité (migration 081). Valeurs stockées en
 * base : ne jamais renuméroter.
 */

/** `verification_request.status` */
const REQUEST_STATUS = Object.freeze({
  PENDING: 0,
  DOCUMENT_REQUESTED: 1,
  APPROVED: 2,
  REFUSED: 3,
  CANCELLED: 4,
  REVOKED: 5,
});

/** Un seul dossier ouvert à la fois : ces deux statuts. */
const OPEN_STATUSES = Object.freeze([REQUEST_STATUS.PENDING, REQUEST_STATUS.DOCUMENT_REQUESTED]);

/** `verification_document.doc_type` */
const DOC_TYPE = Object.freeze({
  REGISTRY: 0,
  IDENTITY: 1,
  ADDRESS: 2,
  NOTORIETY: 3,
  SELFIE: 4,
});

/** Les pièces sont détruites 90 jours après la décision. */
const DOC_RETENTION_DAYS = 90;

/** Photos de pièce et selfie ; le PDF pour une pièce scannée. */
const DOC_MIME = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']);
const DOC_MAX_BYTES = 10 * 1024 * 1024;

const REQUEST_STATUS_NAME = Object.freeze({
  0: 'pending',
  1: 'document_requested',
  2: 'approved',
  3: 'refused',
  4: 'cancelled',
  5: 'revoked',
});

module.exports = {
  REQUEST_STATUS,
  OPEN_STATUSES,
  DOC_TYPE,
  DOC_RETENTION_DAYS,
  DOC_MIME,
  DOC_MAX_BYTES,
  REQUEST_STATUS_NAME,
};
