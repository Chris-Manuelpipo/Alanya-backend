const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/auth');
const {
  createTrip,
  getActiveTrips,
  getTrip,
} = require('../controllers/tripController');

/**
 * @swagger
 * tags:
 *   name: Trips
 *   description: >
 *     Trajets de confiance — partage de position au cercle de confiance
 *     (liste système `trust`, 5 membres au plus) avec échéance d'arrivée.
 *     L'audience n'est jamais un paramètre : le serveur lit la liste Confiance
 *     du porteur du jeton, en entier.
 */

/**
 * @swagger
 * /api/trips:
 *   post:
 *     summary: Démarrer un trajet
 *     description: >
 *       Crée un trajet et pose une carte (message de type 9) dans la
 *       conversation de chaque membre du cercle. Idempotent sur `clientId`.
 *       L'échéance est calculée et gardée par le serveur.
 *     tags: [Trips]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [clientId]
 *             properties:
 *               clientId:
 *                 type: string
 *                 maxLength: 64
 *                 description: Identifiant client, pour l'idempotence
 *               kind:
 *                 type: string
 *                 enum: [taxi, meeting]
 *                 default: meeting
 *               etaAt:
 *                 type: string
 *                 format: date-time
 *                 description: Heure d'arrivée estimée (exclusif avec durationMin)
 *               durationMin:
 *                 type: integer
 *                 description: Durée estimée en minutes (exclusif avec etaAt)
 *               note:
 *                 type: string
 *                 maxLength: 200
 *                 description: "Note pour le cercle — ex. « taxi jaune, plaque LT 4471 »"
 *               deviceId:
 *                 type: string
 *                 description: Appareil émetteur ; lui seul pourra envoyer des positions
 *     responses:
 *       201:
 *         description: Trajet créé, avec la politique de cadence servie
 *       200:
 *         description: Trajet déjà créé avec ce clientId (idempotence)
 *       400:
 *         description: clientId manquant, ou échéance invalide
 *       409:
 *         description: >
 *           `TRIP_ALREADY_ACTIVE` — un trajet est déjà ouvert ;
 *           `TRUST_LIST_EMPTY` — le cercle de confiance est vide
 *       501:
 *         description: "`SOS_NOT_AVAILABLE` — le SOS n'est pas dans ce lot"
 */
router.post('/', auth, createTrip);

/**
 * @swagger
 * /api/trips/active:
 *   get:
 *     summary: Mon trajet ouvert, et ceux que je suis
 *     description: >
 *       Premier appel de l'application au démarrage. Renvoie aussi `policy`,
 *       la cadence GPS à appliquer — le client ne doit pas la coder en dur.
 *     tags: [Trips]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ mine, watching[], policy }"
 */
router.get('/active', auth, getActiveTrips);

/**
 * @swagger
 * /api/trips/{tripId}:
 *   get:
 *     summary: Détail d'un trajet et sa frise d'événements
 *     description: >
 *       Accessible au propriétaire et aux destinataires actifs. Un destinataire
 *       reçoit le nombre de personnes qui suivent, jamais leur identité.
 *     tags: [Trips]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: tripId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: "{ trip, events[], policy }"
 *       400:
 *         description: tripId invalide
 *       404:
 *         description: Trajet introuvable, ou non accessible
 */
router.get('/:tripId', auth, getTrip);

module.exports = router;
