const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/auth');
const {
  createTrip,
  getActiveTrips,
  getTrip,
  confirmTrip,
  extendTrip,
  createSosTrip,
  triggerSos,
  cancelTrip,
  revokeWatcher,
  getHistory,
  getPoints,
  deleteTrip,
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
 * /api/trips/history:
 *   get:
 *     summary: Mes trajets passés
 *     description: >
 *       Réservé au propriétaire. Un destinataire n'a **pas** d'historique :
 *       c'est ce qui empêche la fonctionnalité de devenir un outil de contrôle
 *       a posteriori.
 *     tags: [Trips]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: cursor
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 50 }
 *     responses:
 *       200:
 *         description: "{ trips[], nextCursor }"
 */
router.get('/history', auth, getHistory);

/**
 * @swagger
 * /api/trips/sos:
 *   post:
 *     summary: Déclencher un SOS
 *     description: >
 *       Fonctionne **sans trajet en cours** : le danger n'attend pas un trajet
 *       planifié. Crée alors un trajet sans destination ni échéance,
 *       immédiatement en alerte. Si un trajet est déjà ouvert, il est escaladé
 *       plutôt que dédoublé.
 *     tags: [Trips]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               clientId: { type: string, maxLength: 64 }
 *               deviceId: { type: string }
 *     responses:
 *       201: { description: SOS déclenché }
 *       200: { description: Trajet existant escaladé }
 *       409: { description: "`TRUST_LIST_EMPTY`" }
 *       429: { description: "`SOS_RATE_LIMITED` — plafond `TRIP_SOS_MAX_24H` / 24 h" }
 */
router.post('/sos', auth, createSosTrip);

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

/**
 * @swagger
 * /api/trips/{tripId}/confirm:
 *   post:
 *     summary: Confirmer son arrivée
 *     description: >
 *       Possible même après une alerte — mais celle-ci reste au journal :
 *       une alerte émise se résout, elle ne s'efface pas.
 *     tags: [Trips]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: tripId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Trajet clos }
 *       409: { description: "`TRIP_TERMINAL` — déjà clos" }
 */
router.post('/:tripId/confirm', auth, confirmTrip);

/**
 * @swagger
 * /api/trips/{tripId}/extend:
 *   post:
 *     summary: Prolonger l'échéance
 *     description: >
 *       Illimité — un embouteillage ne doit pas coûter une alerte. Repart de
 *       l'échéance courante, pas de maintenant. Écrit un événement visible du
 *       cercle : cela rassure sans alerter.
 *     tags: [Trips]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: tripId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [minutes]
 *             properties:
 *               minutes: { type: integer, minimum: 1, maximum: 240 }
 *     responses:
 *       200: { description: Échéance repoussée }
 *       409: { description: "`MAX_DURATION_REACHED`" }
 */
router.post('/:tripId/extend', auth, extendTrip);

/**
 * @swagger
 * /api/trips/{tripId}/cancel:
 *   post:
 *     summary: Arrêter le partage
 *     description: >
 *       Toujours autorisé, sans confirmation. Le message envoyé au cercle est
 *       délibérément neutre : si arrêter paraissait suspect, arrêter deviendrait
 *       punissable.
 *     tags: [Trips]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: tripId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Trajet arrêté }
 */
router.post('/:tripId/cancel', auth, cancelTrip);

/**
 * @swagger
 * /api/trips/{tripId}/sos:
 *   post:
 *     summary: Escalader un trajet en SOS
 *     tags: [Trips]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: tripId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Trajet passé en SOS }
 *       429: { description: "`SOS_RATE_LIMITED`" }
 */
router.post('/:tripId/sos', auth, triggerSos);

/**
 * @swagger
 * /api/trips/{tripId}/watchers/{alanyaID}:
 *   delete:
 *     summary: Révoquer un destinataire
 *     description: >
 *       Sans effet sur la liste Confiance. Si c'était le dernier, le trajet se
 *       clôt automatiquement quelques minutes plus tard.
 *     tags: [Trips]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: tripId
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: alanyaID
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "{ watchers[] }" }
 */
router.delete('/:tripId/watchers/:alanyaID', auth, revokeWatcher);

/**
 * @swagger
 * /api/trips/{tripId}/points:
 *   get:
 *     summary: La trace d'un trajet
 *     description: >
 *       Vide après la purge — 24 h pour un trajet ordinaire, 30 jours s'il
 *       s'est clos sur une alerte. `purged` le signale explicitement.
 *     tags: [Trips]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: tripId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "{ points[], purged }" }
 */
router.get('/:tripId/points', auth, getPoints);

/**
 * @swagger
 * /api/trips/{tripId}:
 *   delete:
 *     summary: Supprimer un trajet de son historique
 *     description: >
 *       Un trajet clos sur une **alerte** est verrouillé 30 jours. Ce n'est pas
 *       une contrainte technique mais une mesure anti-coercition : personne ne
 *       doit pouvoir contraindre un proche à effacer la trace d'un incident.
 *     tags: [Trips]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: tripId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Supprimé }
 *       409: { description: "`TRIP_STILL_OPEN`" }
 *       423: { description: "`TRIP_INCIDENT_LOCKED` — verrou de 30 jours" }
 */
router.delete('/:tripId', auth, deleteTrip);

module.exports = router;
