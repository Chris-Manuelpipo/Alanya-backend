const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { getMessages, sendMessage, getConversationReactions } = require('../controllers/messageController');

/**
 * @swagger
 * /api/conversations/{id}/messages:
 *   get:
 *     summary: Récupère les messages d'une conversation
 *     tags: [Messages]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de la conversation
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: before
 *         schema:
 *           type: integer
 *         description: ID du message pour pagination cursor
 *     responses:
 *       200:
 *         description: Liste des messages
 *   post:
 *     summary: Envoyer un message
 *     tags: [Messages]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de la conversation
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *               type:
 *                 type: integer
 *                 default: 0
 *                 description: 0=texte, 1=image, etc.
 *               mediaUrl:
 *                 type: string
 *               mediaName:
 *                 type: string
 *               mediaDuration:
 *                 type: number
 *               replyToID:
 *                 type: integer
 *               replyToContent:
 *                 type: string
 *               isStatusReply:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Message envoyé
 */
router.get('/:id/reactions', auth, getConversationReactions);
router.get('/:id/messages', auth, getMessages);
router.post('/:id/messages', auth, sendMessage);

module.exports = router;
