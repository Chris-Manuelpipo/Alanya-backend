const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { getCalls, createCall, endCall } = require('../controllers/callController');

/**
 * @swagger
 * /api/calls:
 *   get:
 *     summary: Historique des appels
 *     tags: [Appels]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Liste des 50 derniers appels
 *   post:
 *     summary: Créer un appel
 *     tags: [Appels]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - idReceiver
 *               - type
 *             properties:
 *               idReceiver:
 *                 type: integer
 *               type:
 *                 type: integer
 *                 enum: [0, 1]
 *                 description: 0=audio, 1=vidéo
 *     responses:
 *       201:
 *         description: Appel créé
 */
router.get('/', auth, getCalls);
router.post('/', auth, createCall);

/**
 * @swagger
 * /api/calls/{id}/end:
 *   put:
 *     summary: Terminer un appel
 *     tags: [Appels]
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
 *               - status
 *             properties:
 *               status:
 *                 type: integer
 *                 enum: [1, 2]
 *                 description: 1=terminé, 2=manqué
 *     responses:
 *       200:
 *         description: Appel terminé
 */
router.put('/:id/end', auth, endCall);

module.exports = router;
