const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const {
  getStatus,
  getMyStatus,
  getStatusViews,
  createStatus,
  deleteStatus,
  viewStatus,
  likeStatus,
  unlikeStatus,
} = require('../controllers/statutController');

/**
 * @swagger
 * /api/status:
 *   get:
 *     summary: Statuts des contacts (audience réciproque)
 *     tags: [Statuts]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Liste des statuts actifs
 *   post:
 *     summary: Créer un statut
 *     tags: [Statuts]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               text:
 *                 type: string
 *               mediaUrl:
 *                 type: string
 *               backgroundColor:
 *                 type: string
 *               type:
 *                 type: integer
 *               mediaDurationMs:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Statut créé
 */
router.get('/',            auth, getStatus);
router.post('/',           auth, createStatus);

/**
 * @swagger
 * /api/status/me:
 *   get:
 *     summary: Mes statuts actifs
 *     tags: [Statuts]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Liste de mes statuts
 */
router.get('/me',          auth, getMyStatus);

/**
 * @swagger
 * /api/status/{id}:
 *   delete:
 *     summary: Supprimer un statut
 *     tags: [Statuts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Statut supprimé
 */
router.delete('/:id',      auth, deleteStatus);

/**
 * @swagger
 * /api/status/{id}/view:
 *   post:
 *     summary: Marquer un statut comme vu
 *     tags: [Statuts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Statut marqué comme vu
 */
router.post('/:id/view',   auth, viewStatus);

/**
 * @swagger
 * /api/status/{id}/views:
 *   get:
 *     summary: Liste des vues d'un statut (propriétaire)
 *     tags: [Statuts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Liste des viewers
 */
router.get('/:id/views',   auth, getStatusViews);

/**
 * @swagger
 * /api/status/{id}/like:
 *   post:
 *     summary: Liker un statut
 *     tags: [Statuts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Statut liké
 *   delete:
 *     summary: Unliker un statut
 *     tags: [Statuts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Like retiré
 */
router.post('/:id/like',   auth, likeStatus);
router.delete('/:id/like', auth, unlikeStatus);

module.exports = router;
