const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const {
  getUserById,
  getUserByPhone,
  searchUsers,
  blockUser,
  unblockUser,
  getBlockStatus,
  getBlockedUsers,
} = require('../controllers/userController');

/**
 * @swagger
 * /api/users/search:
 *   get:
 *     summary: Rechercher des utilisateurs
 *     tags: [Utilisateurs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *         description: Recherche par nom, pseudo ou téléphone
 *     responses:
 *       200:
 *         description: Résultats de la recherche (max 20)
 */
router.get('/search',       auth, searchUsers);

/**
 * @swagger
 * /api/users/blocked:
 *   get:
 *     summary: Liste des utilisateurs bloqués par moi
 *     tags: [Utilisateurs]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Liste des profils bloqués
 */
router.get('/blocked', auth, getBlockedUsers);

/**
 * @swagger
 * /api/users/phone/{phone}:
 *   get:
 *     summary: Récupérer un utilisateur par téléphone
 *     tags: [Utilisateurs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: phone
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Profil utilisateur
 */
router.get('/phone/:phone', auth, getUserByPhone);

/**
 * @swagger
 * /api/users/{id}:
 *   get:
 *     summary: Récupérer un utilisateur par ID
 *     tags: [Utilisateurs]
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
 *         description: Profil utilisateur
 */
router.get('/:id',          auth, getUserById);

/**
 * @swagger
 * /api/users/{id}/block:
 *   get:
 *     summary: Vérifier le statut de blocage
 *     tags: [Utilisateurs]
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
 *         description: Statut de blocage
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isBlocked:
 *                   type: boolean
 *   post:
 *     summary: Bloquer un utilisateur
 *     tags: [Utilisateurs]
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
 *         description: Utilisateur bloqué
 *   delete:
 *     summary: Débloquer un utilisateur
 *     tags: [Utilisateurs]
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
 *         description: Utilisateur débloqué
 */
router.get('/:id/block',    auth, getBlockStatus);
router.post('/:id/block',   auth, blockUser);
router.delete('/:id/block', auth, unblockUser);

module.exports = router;
