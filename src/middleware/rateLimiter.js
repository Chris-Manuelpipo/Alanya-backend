// src/middleware/rateLimiter.js
// Rate limiter — stub fonctionnel (pas de limitation active)
// Remplacer par express-rate-limit si nécessaire en production

const generalLimiter = (req, res, next) => next();

module.exports = { generalLimiter }; 