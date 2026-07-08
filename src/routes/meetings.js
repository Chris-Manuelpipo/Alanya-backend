const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');

const {
  getMeetings,
  createMeeting,
  getMeetingById,
  getMeetingByRoom,
  updateMeeting,
  deleteMeeting,
  joinMeeting,
  acceptJoinRequest,
  declineJoinRequest,
  inviteParticipants,
  leaveMeeting,
} = require('../controllers/meetingController');

/**
 * @swagger
 * /api/meetings:
 *   get:
 *     summary: Liste des réunions
 *     tags: [Réunions]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Liste des réunions
 *   post:
 *     summary: Créer une réunion
 *     tags: [Réunions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - start_time
 *               - objet
 *               - room
 *             properties:
 *               start_time:
 *                 type: string
 *                 format: date-time
 *               duree:
 *                 type: integer
 *                 default: 60
 *               objet:
 *                 type: string
 *               room:
 *                 type: string
 *               type_media:
 *                 type: integer
 *                 default: 0
 *     responses:
 *       201:
 *         description: Réunion créée
 */
router.get('/', auth, getMeetings);
router.post('/', auth, createMeeting);

/**
 * @swagger
 * /api/meetings/by-room/{room}:
 *   get:
 *     summary: Récupère une réunion par nom de salon
 *     tags: [Réunions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: room
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Réunion trouvée
 */
router.get('/by-room/:room', auth, getMeetingByRoom);

/**
 * @swagger
 * /api/meetings/{id}:
 *   get:
 *     summary: Détails d'une réunion
 *     tags: [Réunions]
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
 *         description: Détails de la réunion
 *   put:
 *     summary: Mettre à jour une réunion
 *     tags: [Réunions]
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
 *             properties:
 *               start_time:
 *                 type: string
 *                 format: date-time
 *               duree:
 *                 type: integer
 *               objet:
 *                 type: string
 *               room:
 *                 type: string
 *               type_media:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Réunion mise à jour
 *   delete:
 *     summary: Supprimer une réunion
 *     tags: [Réunions]
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
 */
router.get('/:id', auth, getMeetingById);
router.put('/:id', auth, updateMeeting);
router.delete('/:id', auth, deleteMeeting);

/**
 * @swagger
 * /api/meetings/{id}/join:
 *   post:
 *     summary: Rejoindre une réunion
 *     tags: [Réunions]
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
 *         description: Participant ajouté
 */
router.post('/:id/join', auth, joinMeeting);

/**
 * @swagger
 * /api/meetings/{id}/leave:
 *   post:
 *     summary: Quitter une réunion
 *     tags: [Réunions]
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
 *         description: Réunion quittée
 */
router.post('/:id/leave', auth, leaveMeeting);

/**
 * @swagger
 * /api/meetings/{id}/invite:
 *   post:
 *     summary: Inviter des participants à une réunion
 *     tags: [Réunions]
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
 *               - participant_ids
 *             properties:
 *               participant_ids:
 *                 type: array
 *                 items:
 *                   type: integer
 *     responses:
 *       200:
 *         description: Participants invités
 */
router.post('/:id/invite', auth, inviteParticipants);

/**
 * @swagger
 * /api/meetings/{id}/accept/{userId}:
 *   post:
 *     summary: Accepter une demande de participation
 *     tags: [Réunions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Demande acceptée
 */
router.post('/:id/accept/:userId', auth, acceptJoinRequest);

/**
 * @swagger
 * /api/meetings/{id}/decline/{userId}:
 *   post:
 *     summary: Refuser une demande de participation
 *     tags: [Réunions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Demande refusée
 */
router.post('/:id/decline/:userId', auth, declineJoinRequest);

module.exports = router;
