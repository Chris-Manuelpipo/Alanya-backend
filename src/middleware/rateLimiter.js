const rateLimit = require('express-rate-limit');

// ── Auth : login / register ───────────────────────────────────────────
// 10 tentatives par IP par fenêtre de 15 minutes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again in 15 minutes' },
  skipSuccessfulRequests: true, // ne compte que les échecs
});

// ── Messages : envoi ──────────────────────────────────────────────────
// 60 messages par minute par user (identifié par IP, peut être amélioré par JWT)
const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Message rate limit exceeded, slow down' },
});

// ── Upload fichiers ───────────────────────────────────────────────────
// 20 uploads par minute
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Upload rate limit exceeded' },
});

// ── API générale ──────────────────────────────────────────────────────
// 300 requêtes par minute par IP
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down' },
});

module.exports = { authLimiter, messageLimiter, uploadLimiter, generalLimiter };