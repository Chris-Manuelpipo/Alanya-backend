const express = require('express');
const multer = require('multer');
const auth = require('../middleware/auth');
const { DOC_MIME, DOC_MAX_BYTES } = require('../constants/verification');
const {
  getMyVerification,
  submitVerification,
  addVerificationDocuments,
  cancelVerification,
} = require('../controllers/verificationController');

const router = express.Router();

/**
 * Pièces en mémoire, jamais sur disque en clair : le contrôleur les chiffre
 * directement dans le coffre. Surtout pas `uploadMedia`, dont le dossier est
 * servi en statique.
 */
const pieces = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: DOC_MAX_BYTES, files: 3 },
  fileFilter: (req, file, cb) => (DOC_MIME.includes(file.mimetype)
    ? cb(null, true)
    : cb(Object.assign(new Error(`Type de fichier ${file.mimetype} non accepté`), { code: 'INVALID_EXTENSION' }), false)),
}).fields([{ name: 'identity', maxCount: 2 }, { name: 'selfie', maxCount: 1 }]);

function withPieces(req, res, next) {
  pieces(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Fichier trop volumineux', code: 'FILE_TOO_LARGE' });
    }
    if (err.code === 'INVALID_EXTENSION') {
      return res.status(400).json({ error: err.message, code: 'INVALID_EXTENSION' });
    }
    return res.status(400).json({ error: 'Envoi refusé', code: 'UPLOAD_REJECTED' });
  });
}

/**
 * @swagger
 * tags:
 *   name: Verification
 *   description: >
 *     Vérification d'identité — la coche. Pièce d'identité et selfie, chiffrés
 *     dans un coffre hors de uploads/, examinés par l'administration, détruits
 *     90 jours après la décision.
 */

/**
 * @swagger
 * /api/verification:
 *   get:
 *     summary: État du dossier et de la coche du compte connecté
 *     tags: [Verification]
 *     security: [{ bearerAuth: [] }]
 *   post:
 *     summary: Déposer une demande (multipart identity, selfie)
 *     tags: [Verification]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Demande déposée }
 *       400: { description: "`DOCUMENTS_REQUIRED`, `NAME_REQUIRED`, `INVALID_EXTENSION`" }
 *       409: { description: "`VERIFICATION_ALREADY_OPEN`, `VERIFICATION_ALREADY_APPROVED`" }
 *       503: { description: "`VERIFICATION_UNAVAILABLE` — coffre non configuré" }
 *   delete:
 *     summary: Annuler la demande en cours
 *     tags: [Verification]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/', auth, getMyVerification);
router.post('/', auth, withPieces, submitVerification);
router.delete('/', auth, cancelVerification);

/**
 * @swagger
 * /api/verification/documents:
 *   post:
 *     summary: Compléter un dossier en « pièce demandée »
 *     tags: [Verification]
 *     security: [{ bearerAuth: [] }]
 */
router.post('/documents', auth, withPieces, addVerificationDocuments);

module.exports = router;
