const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { getCalls, createCall, endCall, rejectCallHttp } = require('../controllers/callController');

/**
 * @swagger
 * /api/calls:
 *   get:
 *     summary: Historique des appels (paginé)
 *     tags: [Appels]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 100
 *         description: Taille de page
 *       - in: query
 *         name: before
 *         schema:
 *           type: integer
 *         description: >
 *           Curseur — IDcall du plus ancien appel déjà reçu. Renvoie la page
 *           d'appels immédiatement antérieurs. Absent = page la plus récente.
 *     responses:
 *       200:
 *         description: >
 *           Liste d'appels du plus récent au plus ancien. Une page plus courte
 *           que `limit` signale la fin de l'historique.
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
 * /api/calls/reject:
 *   post:
 *     summary: Refus d'appel entrant (HTTP — cold-start CallKit)
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
 *               - callerId
 *             properties:
 *               callerId:
 *                 type: integer
 *               callId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Appel refusé
 */
router.post('/reject', auth, rejectCallHttp);

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
