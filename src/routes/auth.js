const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const authFirebase = require('../middleware/authFirebase');
const {
  verifyToken,
  getMe,
  updateMe,
  register,
  phoneExists,
} = require('../controllers/authController');

/**
 * @swagger
 * /api/auth/phone-exists/{phone}:
 *   get:
 *     summary: Vérifie si un numéro de téléphone existe déjà
 *     tags: [Auth Firebase]
 *     parameters:
 *       - in: path
 *         name: phone
 *         required: true
 *         schema:
 *           type: string
 *         description: Numéro de téléphone
 *     responses:
 *       200:
 *         description: Résultat de l'existence
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 exists:
 *                   type: boolean
 *                 alanyaID:
 *                   type: integer
 *                   nullable: true
 */
router.get('/phone-exists/:phone', phoneExists);

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Inscription via Firebase
 *     tags: [Auth Firebase]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               nom:
 *                 type: string
 *               pseudo:
 *                 type: string
 *               avatar_url:
 *                 type: string
 *               idPays:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Utilisateur créé ou mis à jour
 */
router.post('/register', authFirebase, register);

/**
 * @swagger
 * /api/auth/verify:
 *   post:
 *     summary: Vérifie le token JWT
 *     tags: [Auth Firebase]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Utilisateur authentifié
 */
router.post('/verify', auth, verifyToken);

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     summary: Récupère mon profil (Firebase)
 *     tags: [Auth Firebase]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Profil utilisateur
 *   put:
 *     summary: Met à jour mon profil (Firebase)
 *     tags: [Auth Firebase]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nom:
 *                 type: string
 *               pseudo:
 *                 type: string
 *               avatar_url:
 *                 type: string
 *               fcm_token:
 *                 type: string
 *               device_ID:
 *                 type: string
 *               is_online:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Profil mis à jour
 */
router.get('/me', auth, getMe);
router.put('/me', auth, updateMe);

module.exports = router;
