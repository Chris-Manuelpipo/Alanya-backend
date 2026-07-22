const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { updateMessage, deleteMessage, batchDeleteMessages, batchForwardMessages, pinMessage, markMessageViewed, setReaction, removeReaction, getMessagesSince, getMessageStatusByClientId, getPendingOutgoingMessages } = require('../controllers/messageController');

/**
 * @swagger
 * /api/messages/{id}:
 *   put:
 *     summary: Modifier un message
 *     tags: [Messages]
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
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *     responses:
 *       200:
 *         description: Message modifié
 *   delete:
 *     summary: Supprimer un message
 *     tags: [Messages]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: all
 *         schema:
 *           type: boolean
 *         description: Supprimer pour tous (true) ou seulement pour soi
 *     responses:
 *       200:
 *         description: Message supprimé
 */
// Sync delta globale multi-conversations (curseur par conv). Déclarée avant
// les routes `/:id` pour éviter toute capture par un pattern paramétré.
router.post('/sync', auth, getMessagesSince);
router.get('/status', auth, getMessageStatusByClientId);
router.get('/pending', auth, getPendingOutgoingMessages);
router.post('/batch-delete', auth, batchDeleteMessages);
router.post('/batch-forward', auth, batchForwardMessages);
router.put('/:id/reactions', auth, setReaction);
router.delete('/:id/reactions', auth, removeReaction);
router.put('/:id', auth, updateMessage);
router.delete('/:id', auth, deleteMessage);
router.patch('/:id/pin', auth, pinMessage);
router.post('/:id/view', auth, markMessageViewed);

module.exports = router;
