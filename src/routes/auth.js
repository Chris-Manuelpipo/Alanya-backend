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

router.get('/phone-exists/:phone', phoneExists);
router.post('/register', authFirebase, register);
router.post('/verify', auth, verifyToken);
router.get('/me', auth, getMe);
router.put('/me', auth, updateMe);

module.exports = router;