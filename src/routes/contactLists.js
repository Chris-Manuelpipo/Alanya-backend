const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/auth');
const {
  getLists,
  createList,
  updateList,
  updateSoundOrder,
  deleteList,
  getListMembers,
  addMember,
  removeMember,
} = require('../controllers/contactListController');

/**
 * @swagger
 * /api/contact-lists:
 *   get:
 *     summary: Listes de contacts du propriétaire (avec nombre de membres)
 *     tags: [ContactLists]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Liste des listes
 *   post:
 *     summary: Créer une liste de contacts
 *     tags: [ContactLists]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *                 maxLength: 60
 *               color:
 *                 type: string
 *                 description: "#RGB, #RRGGBB ou #RRGGBBAA — sinon ignorée"
 *     responses:
 *       201:
 *         description: Liste créée
 *       400:
 *         description: Nom manquant
 *       409:
 *         description: Une liste porte déjà ce nom
 */
router.get('/',    auth, getLists);
router.post('/',   auth, createList);

/**
 * @swagger
 * /api/contact-lists/sound-order:
 *   put:
 *     summary: Ordre de priorité des sonneries de liste (contact multi-listes)
 *     tags: [ContactLists]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [order]
 *             properties:
 *               order:
 *                 type: array
 *                 items:
 *                   type: integer
 *                 description: idList du plus prioritaire au moins prioritaire
 *     responses:
 *       200:
 *         description: Ordre enregistré
 *       400:
 *         description: Corps invalide
 */
// ⚠ AVANT `/:idList` : sinon Express fait correspondre « sound-order » au
// paramètre et la requête finit en 400 « Invalid list ID ».
router.put('/sound-order', auth, updateSoundOrder);

/**
 * @swagger
 * /api/contact-lists/{idList}:
 *   put:
 *     summary: Renommer, recolorer ou choisir les sonneries d'une liste
 *     tags: [ContactLists]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: idList
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 maxLength: 60
 *               color:
 *                 type: string
 *                 nullable: true
 *               messageSoundType:
 *                 type: string
 *                 enum: [builtin, custom]
 *                 nullable: true
 *               messageSoundId:
 *                 type: string
 *                 nullable: true
 *                 description: "id du son fourni, ou SHA-256 du fichier importé"
 *               messageSoundName:
 *                 type: string
 *                 nullable: true
 *                 description: "nom du fichier importé — affichage seulement"
 *               callSoundType:
 *                 type: string
 *                 enum: [builtin, custom]
 *                 nullable: true
 *               callSoundId:
 *                 type: string
 *                 nullable: true
 *               callSoundName:
 *                 type: string
 *                 nullable: true
 *     responses:
 *       200:
 *         description: Liste mise à jour
 *       404:
 *         description: Liste introuvable
 *       409:
 *         description: Une liste porte déjà ce nom
 *   delete:
 *     summary: Supprimer une liste (les membres suivent en cascade)
 *     tags: [ContactLists]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: idList
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Liste supprimée
 *       404:
 *         description: Liste introuvable
 */
router.put('/:idList',    auth, updateList);
router.delete('/:idList', auth, deleteList);

/**
 * @swagger
 * /api/contact-lists/{idList}/members:
 *   get:
 *     summary: Membres d'une liste
 *     tags: [ContactLists]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: idList
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Membres de la liste
 *       404:
 *         description: Liste introuvable
 */
router.get('/:idList/members', auth, getListMembers);

/**
 * @swagger
 * /api/contact-lists/{idList}/members/{friendID}:
 *   post:
 *     summary: Ajouter un contact préféré à une liste
 *     tags: [ContactLists]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: idList
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: friendID
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       201:
 *         description: Membre ajouté
 *       403:
 *         description: L'utilisateur n'est pas un contact préféré
 *       404:
 *         description: Liste introuvable
 *   delete:
 *     summary: Retirer un membre d'une liste
 *     tags: [ContactLists]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: idList
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: friendID
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Membre retiré
 *       404:
 *         description: Liste ou membre introuvable
 */
router.post('/:idList/members/:friendID',   auth, addMember);
router.delete('/:idList/members/:friendID', auth, removeMember);

module.exports = router;
