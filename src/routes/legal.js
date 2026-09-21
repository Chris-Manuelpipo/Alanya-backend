// Pages publiques exigées par Google pour l'écran OAuth (Drive) et par
// l'écran « À propos » de l'application. Servies à la racine, hors /api.

const express = require('express');
const router = express.Router();
const {
  showHome,
  showPrivacy,
  showTerms,
  showLicenses,
} = require('../controllers/legalController');

router.get('/', showHome);
router.get('/legal/privacy', showPrivacy);
router.get('/legal/terms', showTerms);
router.get('/legal/licenses', showLicenses);

module.exports = router;
