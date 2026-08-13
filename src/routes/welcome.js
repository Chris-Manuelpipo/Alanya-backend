const express = require('express');
const auth = require('../middleware/auth');
const { deliver } = require('../controllers/welcomeController');

const router = express.Router();

router.post('/deliver', auth, deliver);

module.exports = router;
