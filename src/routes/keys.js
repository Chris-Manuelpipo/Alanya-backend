const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { uploadKeys, getBundle, getKeyCount, getVaultSalt } = require('../controllers/keysController');

/**
 * @swagger
 * /api/keys/upload:
 *   post:
 *     summary: Dépose le prekey bundle (X3DH) et un lot de one-time prekeys
 *     tags: [Keys]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [identityKeyDh, identityKeySign, signedPrekey]
 *             properties:
 *               identityKeyDh:
 *                 type: string
 *                 description: Clé publique X25519 d'identité (DH), encodée en base64
 *               identityKeySign:
 *                 type: string
 *                 description: Clé publique Ed25519 d'identité (signature), encodée en base64
 *               signedPrekey:
 *                 type: object
 *                 required: [keyId, publicKey, signature]
 *                 properties:
 *                   keyId:
 *                     type: integer
 *                   publicKey:
 *                     type: string
 *                     description: Clé publique signée, encodée en base64
 *                   signature:
 *                     type: string
 *                     description: Signature de publicKey (par identityKeySign), encodée en base64
 *               registrationId:
 *                 type: integer
 *                 description: Optionnel, non utilisé par le client actuel
 *               oneTimePreKeys:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     keyId:
 *                       type: integer
 *                     publicKey:
 *                       type: string
 *                       description: Clé publique à usage unique, encodée en base64
 *     responses:
 *       201:
 *         description: Clés déposées
 */
router.post('/upload', auth, uploadKeys);

/**
 * @swagger
 * /api/keys/count:
 *   get:
 *     summary: Nombre de one-time prekeys non utilisées de l'utilisateur connecté
 *     tags: [Keys]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Compteur
 */
router.get('/count', auth, getKeyCount);

/**
 * @swagger
 * /api/keys/vault-salt:
 *   get:
 *     summary: Récupère (ou génère si absent) le vault_salt de l'utilisateur connecté
 *     tags: [Keys]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: vault_salt encodé en base64
 */
router.get('/vault-salt', auth, getVaultSalt);

/**
 * @swagger
 * /api/keys/{alanyaID}/bundle:
 *   get:
 *     summary: Récupère le bundle public d'un utilisateur (X3DH) + consomme une one-time prekey
 *     tags: [Keys]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: alanyaID
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Bundle de clés publiques
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 identityKeyDh:
 *                   type: string
 *                 identityKeySign:
 *                   type: string
 *                 signedPrekey:
 *                   type: object
 *                   properties:
 *                     keyId:
 *                       type: integer
 *                     publicKey:
 *                       type: string
 *                     signature:
 *                       type: string
 *                 prekey:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     keyId:
 *                       type: integer
 *                     publicKey:
 *                       type: string
 *       404:
 *         description: Aucun bundle pour cet utilisateur
 */
router.get('/:alanyaID/bundle', auth, getBundle);

module.exports = router;
