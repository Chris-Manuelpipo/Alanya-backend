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

// Public
router.post('/register',                  register);
router.post('/login',                     login);
router.post('/refresh',                   refreshToken);
router.post('/reset-password',            resetPassword);              // Legacy endpoint
router.post('/forgot-password',           requestPasswordReset);       // New: Step 1 - Request OTP
router.post('/validate-otp',              validateOTP);                // New: Step 2 - Validate OTP
router.post('/reset-password-confirm',    completePasswordReset);      // New: Step 3 - Complete reset

// Protégées
router.get('/me',         authCustom, getMe);
router.put('/me',         authCustom, updateMe);
router.put('/fcm-token',  authCustom, updateFcmToken);

module.exports = router;