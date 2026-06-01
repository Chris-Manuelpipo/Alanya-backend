const express = require('express');
const auth    = require('../middleware/auth');
const { sendToUser } = require('../services/notificationService');

const router = express.Router();

/**
 * @swagger
 * /notify:
 *   post:
 *     summary: Envoyer une notification push à un utilisateur
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - toUserId
 *             properties:
 *               toUserId:
 *                 type: integer
 *               title:
 *                 type: string
 *               body:
 *                 type: string
 *               type:
 *                 type: string
 *               conversationId:
 *                 type: string
 *               callerId:
 *                 type: string
 *               offer:
 *                 type: string
 *               roomId:
 *                 type: string
 *               isVideo:
 *                 type: string
 *     responses:
 *       200:
 *         description: Notification envoyée
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 */
router.post('/', auth, async (req, res, next) => {
  try {
    const {
      toUserId,
      title,
      body,
      type,
      conversationId,
      callerId,
      offer,
      roomId,
      isVideo,
    } = req.body;

    const id = parseInt(String(toUserId), 10);
    if (!id || Number.isNaN(id)) {
      return res.status(400).json({ error: 'toUserId invalide' });
    }

    const payload = {
      type:  String(type  || 'message'),
      title: String(title || ''),
      body:  String(body  || ''),
    };
    if (conversationId != null) payload.conversationId = String(conversationId);
    if (callerId       != null) payload.callerId       = String(callerId);
    if (roomId         != null) payload.roomId         = String(roomId);
    if (isVideo        != null) payload.isVideo        = String(isVideo);
    if (offer          != null) {
      payload.offer = typeof offer === 'string' ? offer : JSON.stringify(offer);
    }

    await sendToUser(id, payload);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
