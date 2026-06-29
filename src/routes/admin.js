const express = require('express');
const router = express.Router();
const { adminAuth, superAdminAuth } = require('../middleware/adminAuth');
const {
  adminLogin,
  getStats,
  getAnalytics,
  getActivityFeed,
  getAllMedia,
  deleteMedia,
  getAllGroups,
  getGroupById,
  deleteGroup,
  getAllMeetings,
  endMeeting,
  deleteMeeting,
  getSettings,
  updateSettings,
  getUsers,
  getUserById,
  getUserActivity,
  getUserLogins,
  banUser,
  unbanUser,
  setAccountType,
  deleteUser,
  createUser,
  updateUserPhone,
  listReservedPhones,
  addReservedPhone,
  removeReservedPhone,
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
 * /api/admin/analytics:
 *   get:
 *     summary: Analytics avancées (messagerie, appels, stories, réunions, users)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date
 *         description: Date début (ISO, défaut J-7)
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date
 *         description: Date fin (ISO, défaut maintenant)
 *     responses:
 *       200:
 *         description: Agrégations analytiques groupées par domaine
 */
router.get('/analytics',                   adminAuth, getAnalytics);

/**
 * @swagger
 * /api/admin/activity:
 *   get:
 *     summary: Feed d'activité récente (événements fusionnés et triés)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Liste des derniers événements
 */
router.get('/activity',                    adminAuth, getActivityFeed);

/**
 * @swagger
 * /api/admin/media:
 *   get:
 *     summary: Médias partagés (images, vidéos, audios, fichiers)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: integer
 *           enum: [1, 2, 3, 4]
 *         description: 1=image 2=vidéo 3=audio 4=fichier
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 200
 *     responses:
 *       200:
 *         description: Liste des médias
 */
router.get('/media',                       adminAuth, getAllMedia);

/**
 * @swagger
 * /api/admin/media/{id}:
 *   delete:
 *     summary: Masque un média (soft-delete du message)
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
 *         description: Média supprimé
 *       404:
 *         description: Média introuvable
 */
router.delete('/media/:id',                adminAuth, deleteMedia);

/**
 * @swagger
 * /api/admin/meetings:
 *   get:
 *     summary: Toutes les réunions de l'application
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 200
 *     responses:
 *       200:
 *         description: Liste des réunions
 */
router.get('/meetings',                    adminAuth, getAllMeetings);

/**
 * @swagger
 * /api/admin/meetings/{id}/end:
 *   post:
 *     summary: Termine une réunion en cours
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
 *         description: Réunion terminée
 *       404:
 *         description: Réunion introuvable
 */
router.post('/meetings/:id/end',           adminAuth, endMeeting);

/**
 * @swagger
 * /api/admin/meetings/{id}:
 *   delete:
 *     summary: Supprime une réunion (+ participants)
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
 *         description: Réunion supprimée
 *       404:
 *         description: Réunion introuvable
 */
router.delete('/meetings/:id',             adminAuth, deleteMeeting);

/**
 * @swagger
 * /api/admin/settings:
 *   get:
 *     summary: Paramètres applicatifs (maintenance, nom, URL API)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Paramètres courants
 *   put:
 *     summary: Met à jour les paramètres (super-admin)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               maintenance:
 *                 type: boolean
 *               appName:
 *                 type: string
 *               apiUrl:
 *                 type: string
 *     responses:
 *       200:
 *         description: Paramètres mis à jour
 */
router.get('/settings',                    adminAuth, getSettings);
router.put('/settings',                    adminAuth, superAdminAuth, updateSettings);

/**
 * @swagger
 * /api/admin/groups:
 *   get:
 *     summary: Tous les groupes de l'application
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 200
 *     responses:
 *       200:
 *         description: Liste des groupes
 */
router.get('/groups',                      adminAuth, getAllGroups);

/**
 * @swagger
 * /api/admin/groups/{id}:
 *   get:
 *     summary: Détails d'un groupe + membres
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
 *         description: Détails du groupe
 *       404:
 *         description: Groupe introuvable
 *   delete:
 *     summary: Supprime un groupe (messages + participants)
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
 *         description: Groupe supprimé
 */
router.get('/groups/:id',                  adminAuth, getGroupById);
router.delete('/groups/:id',               adminAuth, deleteGroup);

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
router.post('/users',                      adminAuth, createUser);

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
router.put('/users/:id/phone',             adminAuth, superAdminAuth, updateUserPhone);
router.delete('/users/:id',                adminAuth, superAdminAuth, deleteUser);

router.get('/reserved-alanya-phones',      adminAuth, superAdminAuth, listReservedPhones);
router.post('/reserved-alanya-phones',     adminAuth, superAdminAuth, addReservedPhone);
router.delete('/reserved-alanya-phones/:phone', adminAuth, superAdminAuth, removeReservedPhone);

module.exports = router;
