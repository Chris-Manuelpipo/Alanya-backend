const express = require('express');
const router  = express.Router();
const { authCustom } = require('../middleware/authCustom');
const {
  register,
  login,
  refreshToken,
  resetPassword,
  requestPasswordReset,
  validateOTP,
  completePasswordReset,
  getMe,
  updateMe,
  updateFcmToken,
} = require('../controllers/authCustomController');
const {
  registerPushDevice,
  updatePushDeviceState,
  deletePushDevice,
} = require('../controllers/pushDevicesController');

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Inscription par email/mot de passe
 *     tags: [Auth Custom]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 minLength: 6
 *               nom:
 *                 type: string
 *               pseudo:
 *                 type: string
 *               idPays:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Compte créé
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                 accessToken:
 *                   type: string
 *                 refreshToken:
 *                   type: string
 */
router.post('/register',                  register);

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Connexion par email/mot de passe
 *     tags: [Auth Custom]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - alanyaPhone
 *               - password
 *             properties:
 *               alanyaPhone:
 *                 type: string
 *               password:
 *                 type: string
 *               fcm_token:
 *                 type: string
 *               device_ID:
 *                 type: string
 *               device_model:
 *                 type: string
 *               os_system:
 *                 type: string
 *     responses:
 *       200:
 *         description: Connexion réussie
 */
router.post('/login',                     login);

/**
 * @swagger
 * /api/auth/refresh:
 *   post:
 *     summary: Rafraîchit le token d'accès
 *     tags: [Auth Custom]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refreshToken
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Nouveaux tokens
 */
router.post('/refresh',                   refreshToken);

/**
 * @swagger
 * /api/auth/reset-password:
 *   post:
 *     summary: Réinitialisation directe du mot de passe (ancien endpoint)
 *     tags: [Auth Custom]
 *     deprecated: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *               newPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: Mot de passe réinitialisé
 */
router.post('/reset-password',            resetPassword);

/**
 * @swagger
 * /api/auth/forgot-password:
 *   post:
 *     summary: Étape 1 - Demande de réinitialisation (envoie un OTP par email)
 *     tags: [Auth Custom]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: OTP envoyé si l'email existe
 */
router.post('/forgot-password',           requestPasswordReset);

/**
 * @swagger
 * /api/auth/validate-otp:
 *   post:
 *     summary: Étape 2 - Valide l'OTP reçu par email
 *     tags: [Auth Custom]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - otp
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               otp:
 *                 type: string
 *     responses:
 *       200:
 *         description: OTP valide, retourne un resetToken
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 resetToken:
 *                   type: string
 */
router.post('/validate-otp',              validateOTP);

/**
 * @swagger
 * /api/auth/reset-password-confirm:
 *   post:
 *     summary: Étape 3 - Réinitialisation du mot de passe avec le resetToken
 *     tags: [Auth Custom]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - resetToken
 *               - newPassword
 *             properties:
 *               resetToken:
 *                 type: string
 *               newPassword:
 *                 type: string
 *                 minLength: 6
 *     responses:
 *       200:
 *         description: Mot de passe réinitialisé avec succès
 */
router.post('/reset-password-confirm',    completePasswordReset);

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     summary: Récupère mon profil (Custom Auth)
 *     tags: [Auth Custom]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Profil utilisateur
 *   put:
 *     summary: Met à jour mon profil (Custom Auth)
 *     tags: [Auth Custom]
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
 *               idPays:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Profil mis à jour
 */
router.get('/me',         authCustom, getMe);
router.put('/me',         authCustom, updateMe);

/**
 * @swagger
 * /api/auth/fcm-token:
 *   put:
 *     summary: Met à jour le token FCM pour les notifications push
 *     tags: [Auth Custom]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fcm_token
 *             properties:
 *               fcm_token:
 *                 type: string
 *     responses:
 *       200:
 *         description: Token FCM mis à jour
 */
router.put('/fcm-token',  authCustom, updateFcmToken);

router.post('/push-devices/register', authCustom, registerPushDevice);
router.post('/push-devices/state', authCustom, updatePushDeviceState);
router.delete('/push-devices/:deviceId', authCustom, deletePushDevice);

module.exports = router;
