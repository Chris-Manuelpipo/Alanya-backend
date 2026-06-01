const express = require('express');
const router = express.Router();
const { adminAuth, superAdminAuth } = require('../middleware/adminAuth');
const {
  adminLogin,
  getStats,
  getUsers,
  getUserById,
  getUserActivity,
  getUserLogins,
  banUser,
  unbanUser,
  setAccountType,
  deleteUser,
} = require('../controllers/adminController');

/**
 * @swagger
 * /api/admin/auth/login:
 *   post:
 *     summary: Connexion admin
 *     tags: [Admin]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Connexion réussie
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 accessToken:
 *                   type: string
 *                 refreshToken:
 *                   type: string
 *                 user:
 *                   type: object
 */
router.post('/auth/login', adminLogin);

/**
 * @swagger
 * /api/admin/stats:
 *   get:
 *     summary: Statistiques du tableau de bord
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date
 *         description: Date début (ISO)
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date
 *         description: Date fin (ISO)
 *     responses:
 *       200:
 *         description: Statistiques
 */
router.get('/stats',                       adminAuth, getStats);

/**
 * @swagger
 * /api/admin/users:
 *   get:
 *     summary: Liste paginée des utilisateurs
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [online, banned, admin]
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: idPays
 *         schema:
 *           type: integer
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Liste des utilisateurs
 */
router.get('/users',                       adminAuth, getUsers);

/**
 * @swagger
 * /api/admin/users/{id}:
 *   get:
 *     summary: Détails d'un utilisateur
 *     tags: [Admin]
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
 *         description: Détails utilisateur
 *   delete:
 *     summary: Supprime un utilisateur (super-admin)
 *     tags: [Admin]
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
 *         description: Utilisateur supprimé
 */
router.get('/users/:id',                   adminAuth, getUserById);

/**
 * @swagger
 * /api/admin/users/{id}/activity:
 *   get:
 *     summary: Activité d'un utilisateur
 *     tags: [Admin]
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
 *         description: Compteurs d'activité
 */
router.get('/users/:id/activity',          adminAuth, getUserActivity);

/**
 * @swagger
 * /api/admin/users/{id}/logins:
 *   get:
 *     summary: Historique des connexions d'un utilisateur
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: Historique des connexions
 */
router.get('/users/:id/logins',            adminAuth, getUserLogins);

/**
 * @swagger
 * /api/admin/users/{id}/ban:
 *   post:
 *     summary: Bannir un utilisateur
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Utilisateur banni
 *   delete:
 *     summary: Débannir un utilisateur
 *     tags: [Admin]
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
 *         description: Utilisateur débanni
 */
router.post('/users/:id/ban',              adminAuth, banUser);
router.delete('/users/:id/ban',            adminAuth, unbanUser);

/**
 * @swagger
 * /api/admin/users/{id}/role:
 *   put:
 *     summary: Modifie le rôle d'un utilisateur (super-admin)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - type_compte
 *             properties:
 *               type_compte:
 *                 type: integer
 *                 enum: [0, 1, 2]
 *                 description: 0=utilisateur, 1=admin, 2=super-admin
 *     responses:
 *       200:
 *         description: Rôle mis à jour
 */
router.put('/users/:id/role',              adminAuth, superAdminAuth, setAccountType);
router.delete('/users/:id',                adminAuth, superAdminAuth, deleteUser);

module.exports = router;
