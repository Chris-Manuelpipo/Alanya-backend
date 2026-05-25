const rateLimit = require('express-rate-limit');

// Login / Register  
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, veuillez réessayer dans 15 minutes' },
  skipSuccessfulRequests: true, 
});

// Messages : envoi
const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de messages, ralentissez' },
});

// Upload fichiers : 20 uploads par minute
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Limite de téléchargement dépassée' },
});

//  API générale 
// 300 requêtes par minute par IP
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, veuillez ralentir' },
});

module.exports = { authLimiter, messageLimiter, uploadLimiter, generalLimiter };