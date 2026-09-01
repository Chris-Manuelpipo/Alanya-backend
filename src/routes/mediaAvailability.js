const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { checkAvailability } = require('../controllers/mediaAvailabilityController');

/**
 * @swagger
 * /api/media/availability:
 *   post:
 *     summary: Parmi ces médias, lesquels existent encore sur le serveur
 *     description: >
 *       Interrogé avant une exportation de période, pour annoncer à l'inscrit
 *       un décompte et un poids exacts au lieu d'une estimation. Économise de
 *       la bande passante : une requête de quelques kilo-octets remplace des
 *       dizaines de téléchargements voués au 410.
 *     tags: [Media]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ available: [msgID], bytes: { msgID: taille } }"
 *       400:
 *         description: msgIDs manquant ou trop nombreux
 */
router.post('/availability', auth, checkAvailability);

module.exports = router;
