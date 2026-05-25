const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const JWT_SECRET = process.env.JWT_SECRET || 'talky-secret-key-change-in-production';

// Vérifie le JWT + charge le user + exige type_compte >= 1
const adminAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Pas de token fourni' });
    }

    const token = authHeader.split('Bearer ')[1];

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expiré', code: 'TOKEN_EXPIRED' });
      }
      return res.status(401).json({ error: 'Token invalide' });
    }

    if (decoded.type !== 'access') {
      return res.status(401).json({ error: 'Type de token invalide' });
    }

    const [rows] = await pool.execute(
      `SELECT alanyaID, alanyaPhone, email, type_compte
       FROM users WHERE alanyaID = ? AND exclus = 0`,
      [decoded.alanyaID]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Utilisateur non trouvé ou banni' });
    }

    const u = rows[0];
    if ((u.type_compte ?? 0) < 1) {
      return res.status(403).json({ error: 'Accès admin requis' });
    }

    req.user = {
      alanyaID: u.alanyaID,
      phone: u.alanyaPhone,
      email: u.email,
      typeCompte: u.type_compte ?? 0,
    };
    next();
  } catch (error) {
    console.error('[AdminAuth] ERROR:', error.message);
    return res.status(401).json({ error: 'Échec d\'authentification admin' });
  }
};

// Exige type_compte === 2 (super-admin). À utiliser APRÈS adminAuth.
const superAdminAuth = (req, res, next) => {
  if (!req.user || (req.user.typeCompte ?? 0) < 2) {
    return res.status(403).json({ error: 'Accès super-admin requis' });
  }
  next();
};

module.exports = { adminAuth, superAdminAuth };
