// src/routes/turn.js
// GET /api/turn/credentials
// Retourne la config WebRTC iceServers à utiliser côté client.
// Auth requis — évite l'exposition publique des credentials TURN.

const express = require('express');
const router  = express.Router();
const { authCustom } = require('../middleware/authCustom');
const { buildIceServers } = require('../utils/turnCredentials');

router.get('/credentials', authCustom, (req, res) => {
  try {
    const { iceServers, ttlSec } = buildIceServers(req.user.alanyaID);
    res.json({ iceServers, ttlSec });
  } catch (error) {
    console.error('[TURN] credentials error:', error.message);
    res.status(500).json({ error: 'Failed to build iceServers' });
  }
});

module.exports = router;
