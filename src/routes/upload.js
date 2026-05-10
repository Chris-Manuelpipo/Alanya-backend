// src/routes/upload.js
// Route upload — à implémenter si nécessaire
const express = require('express');
const router = express.Router();

// Stub : route non implémentée pour l'instant
router.post('/', (req, res) => {
  res.status(501).json({ error: 'Upload non implémenté' });
});

module.exports = router;