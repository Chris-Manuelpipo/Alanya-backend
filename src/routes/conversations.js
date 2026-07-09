const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const {
  getConversations,
  getConversationById,
  createConversation,
  createGroup,
  updateConversation,
  deleteConversation,
  markAsRead,
  leaveGroup,
  addParticipants,
  batchUpdateConversations,
  batchDeleteConversations,
} = require('../controllers/conversationController');

/**
 * @swagger
 * /api/conversations:
 *   get:
 *     summary: Liste des conversations
 *     tags: [Conversations]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Liste des conversations
 *   post:
 *     summary: Créer une conversation privée (1-1)
 *     tags: [Conversations]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - participantID
 *             properties:
 *               participantID:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Conversation créée
 */
router.get('/', auth, getConversations);
router.post('/', auth, createConversation);
router.patch('/batch', auth, batchUpdateConversations);
router.post('/batch-delete', auth, batchDeleteConversations);

/**
 * @swagger
 * /api/conversations/group:
 *   post:
 *     summary: Créer un groupe
 *     tags: [Conversations]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - participantIDs
 *             properties:
 *               participantIDs:
 *                 type: array
 *                 items:
 *                   type: integer
 *               groupName:
 *                 type: string
 *               groupPhoto:
 *                 type: string
 *     responses:
 *       201:
 *         description: Groupe créé
 */
router.post('/group', auth, createGroup);

/**
 * @swagger
 * /api/conversations/{id}:
 *   get:
 *     summary: Détails d'une conversation
 *     tags: [Conversations]
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
 *         description: Détails de la conversation
 *   put:
 *     summary: Mettre à jour une conversation
 *     tags: [Conversations]
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
 *               GroupName:
 *                 type: string
 *               groupPhoto:
 *                 type: string
 *               isPinned:
 *                 type: boolean
 *               isArchived:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Conversation mise à jour
 *   delete:
 *     summary: Supprimer une conversation (quitter)
 *     tags: [Conversations]
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
 *         description: Conversation supprimée
 */
router.get('/:id', auth, getConversationById);
router.put('/:id', auth, updateConversation);
router.delete('/:id', auth, deleteConversation);

/**
 * @swagger
 * /api/conversations/{id}/read:
 *   post:
 *     summary: Marquer les messages comme lus
 *     tags: [Conversations]
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
 *         description: Messages marqués comme lus
 */
router.post('/:id/read', auth, markAsRead);

/**
 * @swagger
 * /api/conversations/{id}/leave:
 *   post:
 *     summary: Quitter un groupe
 *     tags: [Conversations]
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
 *         description: Groupe quitté
 */
router.post('/:id/leave', auth, leaveGroup);

/**
 * @swagger
 * /api/conversations/{id}/participants:
 *   post:
 *     summary: Ajouter des participants à un groupe
 *     tags: [Conversations]
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
 *               - participantIDs
 *             properties:
 *               participantIDs:
 *                 type: array
 *                 items:
 *                   type: integer
 *     responses:
 *       200:
 *         description: Participants ajoutés
 */
router.post('/:id/participants', auth, addParticipants);

module.exports = router;
