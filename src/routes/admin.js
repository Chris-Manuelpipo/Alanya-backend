const express = require('express');
const router = express.Router();
// `superAdminAuth` n'est plus utilisé ici : chaque route déclare désormais la
// permission qu'elle exige plutôt que le niveau qu'elle suppose. Le middleware
// reste exporté — il redevient utile le jour où une route hors de ce routeur
// aurait besoin d'un garde par niveau.
const { adminAuth, requirePermission } = require('../middleware/adminAuth');
const { adminAudit } = require('../middleware/adminAudit');

// Journal des actions : monté une fois pour tout le routeur, avant les routes.
// L'écriture a lieu après la réponse — voir `middleware/adminAudit.js` pour
// pourquoi ce n'est pas dans les contrôleurs.
router.use(adminAudit);
const { getPurges, updatePurge, runPurgeNow } = require('../controllers/admin/purges');
const { getAudit, getAuditActions } = require('../controllers/admin/audit');
const {
  adminLogin,
  getStats,
  getAnalytics,
  getTripStats,
  getTripRetention,
  runTripPurge,
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
  setUserSocle,
  deleteUser,
  createUser,
  updateUserPhone,
  listReservedPhones,
  checkAssignablePhone,
  addReservedPhone,
  removeReservedPhone,
  getMe,
  updateMe,
  updatePassword,
  exportUsers,
  exportAnalytics,
} = require('../controllers/adminController');
const { broadcastSendLimiter, broadcastEstimateLimiter } = require('../middleware/rateLimiter');

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

// ── Profil admin ──
router.get('/me',                            adminAuth, requirePermission('profile.read'), getMe);
router.put('/me',                            adminAuth, requirePermission('profile.update'), updateMe);
router.put('/me/password',                   adminAuth, requirePermission('profile.password'), updatePassword);

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
router.get('/stats',                       adminAuth, requirePermission('stats.read'), getStats);

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
router.get('/analytics',                   adminAuth, requirePermission('stats.read'), getAnalytics);

/**
 * @swagger
 * /api/admin/trips:
 *   get:
 *     summary: Compteurs agrégés des trajets de confiance (sans identité ni coordonnées)
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
 *         description: KPIs anonymes (démarrés, issues, durées, SOS)
 */
router.get('/trips',                       adminAuth, requirePermission('trips.read'), getTripStats);

/**
 * @swagger
 * /api/admin/trips/retention:
 *   get:
 *     summary: État de la rétention des traces GPS (compteurs seuls, sans identité)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Durées de rétention, volumes stockés et purgeables, journal des purges
 */
router.get('/trips/retention',             adminAuth, requirePermission('trips.read'), getTripRetention);

/**
 * @swagger
 * /api/admin/trips/retention/purge:
 *   post:
 *     summary: Purge manuelle des traces GPS (super-admin)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               scope:
 *                 type: string
 *                 enum: [retention, all]
 *                 description: >
 *                   `retention` applique la politique tout de suite ;
 *                   `all` efface la trace de tous les trajets clos.
 *                   Les trajets en cours ne sont jamais touchés.
 *     responses:
 *       200:
 *         description: Compteurs après purge et journal mis à jour
 */
router.post('/trips/retention/purge',      adminAuth, requirePermission('trips.purge'), runTripPurge);

/**
 * @swagger
 * /api/admin/purges:
 *   get:
 *     summary: État des purges de rétention (réglages, volumétrie purgeable, historique)
 *     tags: [Admin]
 *     description: >
 *       `?stats=0` renvoie les réglages sans les comptages, qui balaient
 *       plusieurs tables — utile pour un simple rafraîchissement d'état.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Liste des purges }
 */
router.get('/purges',                      adminAuth, requirePermission('purges.read'), getPurges);

/**
 * @swagger
 * /api/admin/purges/{name}:
 *   put:
 *     summary: Activer/desactiver une purge ou changer ses durees de retention
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Reglage mis a jour }
 *       404: { description: Purge inconnue }
 */
router.put('/purges/:name',                adminAuth, requirePermission('purges.settings'), updatePurge);

/**
 * @swagger
 * /api/admin/purges/{name}/run:
 *   post:
 *     summary: Executer une purge immediatement
 *     tags: [Admin]
 *     description: >
 *       Independant de l'interrupteur : garder la main pour purger
 *       ponctuellement tout en laissant le balayage automatique coupe est
 *       l'usage attendu.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Purge executee }
 *       404: { description: Purge inconnue }
 */
router.post('/purges/:name/run',           adminAuth, requirePermission('purges.run'), runPurgeNow);

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
router.get('/activity',                    adminAuth, requirePermission('stats.read'), getActivityFeed);

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
router.get('/media',                       adminAuth, requirePermission('media.read'), getAllMedia);

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
router.delete('/media/:id',                adminAuth, requirePermission('media.delete'), deleteMedia);

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
router.get('/meetings',                    adminAuth, requirePermission('meetings.read'), getAllMeetings);

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
router.post('/meetings/:id/end',           adminAuth, requirePermission('meetings.end'), endMeeting);

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
router.delete('/meetings/:id',             adminAuth, requirePermission('meetings.delete'), deleteMeeting);

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
router.get('/settings',                    adminAuth, requirePermission('settings.read'), getSettings);
router.put('/settings',                    adminAuth, requirePermission('settings.write'), updateSettings);

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
router.get('/groups',                      adminAuth, requirePermission('groups.read'), getAllGroups);

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
router.get('/groups/:id',                  adminAuth, requirePermission('groups.read'), getGroupById);
router.delete('/groups/:id',               adminAuth, requirePermission('groups.delete'), deleteGroup);

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
router.get('/users/export',                   adminAuth, requirePermission('users.export'), exportUsers);
router.get('/analytics/export',               adminAuth, requirePermission('analytics.export'), exportAnalytics);
router.get('/users',                       adminAuth, requirePermission('users.read'), getUsers);
router.post('/users',                      adminAuth, requirePermission('users.create'), createUser);

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
router.get('/users/:id',                   adminAuth, requirePermission('users.read'), getUserById);

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
router.get('/users/:id/activity',          adminAuth, requirePermission('users.read'), getUserActivity);

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
router.get('/users/:id/logins',            adminAuth, requirePermission('users.read'), getUserLogins);

// Journal des actions administrateur. Filtrable : sans filtre pour la page
// « Activité admin », avec `targetType`/`targetId` pour l'encart d'une fiche.
router.get('/audit',                       adminAuth, requirePermission('audit.read'), getAudit);
router.get('/audit/actions',               adminAuth, requirePermission('audit.read'), getAuditActions);

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
router.post('/users/:id/ban',              adminAuth, requirePermission('users.ban'), banUser);
router.delete('/users/:id/ban',            adminAuth, requirePermission('users.unban'), unbanUser);

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
router.put('/users/:id/role',              adminAuth, requirePermission('users.role'), setAccountType);
router.put('/users/:id/socle',             adminAuth, requirePermission('users.socle'), setUserSocle);
router.put('/users/:id/phone',             adminAuth, requirePermission('users.phone'), updateUserPhone);
router.delete('/users/:id',                adminAuth, requirePermission('users.delete'), deleteUser);

router.get('/alanya-phones/check-assignable', adminAuth, requirePermission('phones.read'), checkAssignablePhone);
router.get('/reserved-alanya-phones',      adminAuth, requirePermission('phones.read'), listReservedPhones);
router.post('/reserved-alanya-phones',     adminAuth, requirePermission('phones.reserve'), addReservedPhone);
router.delete('/reserved-alanya-phones/:phone', adminAuth, requirePermission('phones.release'), removeReservedPhone);

const {
  listBroadcasts,
  getBroadcast,
  estimateBroadcast,
  createBroadcast,
  cancelScheduled,
} = require('../controllers/admin/broadcast');
const { getVilles } = require('../controllers/admin/villes');
const {
  getOfficialAccount,
  createOfficialAccount,
} = require('../controllers/admin/officialAccount');
const {
  getWelcome,
  updateDraft,
  publish,
  backfill,
  getStatusConfig,
  updateStatusConfig,
} = require('../controllers/admin/welcome');

// Le compte officiel est unique et se crée sans aucune saisie. Sa création est
// un acte irréversible : super-admin, comme setUserSocle et deleteUser.
router.get('/official-account', adminAuth, requirePermission('official.read'), getOfficialAccount);
router.post('/official-account', adminAuth, requirePermission('official.create'), createOfficialAccount);

router.get('/broadcasts', adminAuth, requirePermission('broadcasts.read'), listBroadcasts);
router.get('/broadcasts/:id', adminAuth, requirePermission('broadcasts.read'), getBroadcast);
router.post('/broadcasts/estimate', adminAuth, requirePermission('broadcasts.read'), broadcastEstimateLimiter, estimateBroadcast);
router.post('/broadcasts', adminAuth, requirePermission('broadcasts.send'), broadcastSendLimiter, createBroadcast);
router.delete('/broadcasts/scheduled/:jobId', adminAuth, requirePermission('broadcasts.cancel'), cancelScheduled);
router.get('/villes', adminAuth, requirePermission('villes.read'), getVilles);

router.get('/welcome', adminAuth, requirePermission('welcome.read'), getWelcome);
router.put('/welcome/draft', adminAuth, requirePermission('welcome.draft'), updateDraft);
router.post('/welcome/publish', adminAuth, requirePermission('welcome.publish'), publish);
router.post('/welcome/backfill', adminAuth, requirePermission('welcome.backfill'), backfill);
// Statut de bienvenue : réglage global, appliqué sans publication.
router.get('/welcome/status', adminAuth, requirePermission('welcome.read'), getStatusConfig);
router.put('/welcome/status', adminAuth, requirePermission('welcome.status'), updateStatusConfig);

module.exports = router;
