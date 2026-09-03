const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const {
  requireMeetingParticipant,
  requireMeetingOrganiser,
} = require('../middleware/meetingAuth');

const {
  getMeetings,
  createMeeting,
  getMeetingById,
  getMeetingByRoom,
  updateMeeting,
  deleteMeeting,
  joinMeeting,
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
// requireMeetingParticipant : la route rendait la fiche complète — noms,
// pseudos, avatars, présence — à tout compte authentifié.
router.get('/:id', auth, requireMeetingParticipant, getMeetingById);
// updateMeeting fait déjà sa vérification d'organisateur en ligne.
router.put('/:id', auth, updateMeeting);
// requireMeetingOrganiser : la route supprimait les lignes `participant` avant
// de regarder qui appelait, et répondait 200 dans tous les cas.
router.delete('/:id', auth, requireMeetingOrganiser, deleteMeeting);

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
// requireMeetingParticipant : la route inscrivait l'appelant sans vérifier la
// moindre invitation. Combinée à `GET /:id` et à `meeting:join_room`, la chaîne
// « lire la fiche → s'inscrire → entrer dans la salle » était franchissable par
// n'importe quel compte connaissant un identifiant de réunion.
router.post('/:id/join', auth, requireMeetingParticipant, joinMeeting);

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

// Les routes accept/:userId et decline/:userId, et le RSVP qu'elles
// servaient, ont été retirées : aucun appelant côté application, et leur
// sémantique devenait fausse une fois que `status = 1` a cessé de vouloir
// dire « accepté » pour vouloir dire « a rejoint ». Voir meetingController.js.

module.exports = router;
