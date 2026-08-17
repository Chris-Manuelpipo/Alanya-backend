const rateLimit = require('express-rate-limit');

// Login / Register — échecs uniquement (brute-force). Les inscriptions réussies
// ne consomment pas ce quota ; voir registerLimiter ci-dessous.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, veuillez réessayer dans 15 minutes' },
  skipSuccessfulRequests: true,
});

// Inscriptions réussies par IP — seuls les 2xx comptent (skipFailedRequests).
const registerLimiter = rateLimit({
  windowMs: Number(process.env.REGISTER_WINDOW_MS) || 24 * 60 * 60 * 1000,
  max: Number(process.env.REGISTER_MAX_PER_IP) || 3,
  skipFailedRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({
    error: 'Trop de comptes créés depuis cette connexion, réessayez plus tard',
    code: 'REGISTER_RATE_LIMITED',
  }),
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

// Résolution de QR : 30 par minute
// Défense en profondeur, pas une contrainte fonctionnelle — un humain qui
// scanne dépasse rarement quelques codes par minute. Le plafond sert à rendre
// non rentable l'énumération des jetons opaques (identité ou session), dont la
// sécurité repose déjà sur leur taille.
const qrResolveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de scans, veuillez patienter' },
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

module.exports = { authLimiter, registerLimiter, messageLimiter, uploadLimiter, qrResolveLimiter, generalLimiter,
  broadcastSendLimiter: rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Limite de diffusions atteinte (10/h)' },
  }),
  broadcastEstimateLimiter: rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Trop d\'estimations, patientez' },
  }),
};