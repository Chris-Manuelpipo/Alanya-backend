const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const JWT_SECRET = process.env.JWT_SECRET || 'talky-secret-key-change-in-production';

const auth = async (req, res, next) => {
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

    // Vérifier que c'est bien un access token (pas un refresh token)
    if (decoded.type !== 'access') {
      return res.status(401).json({ error: 'Type de token invalide' });
    }

    // Les tokens émis avant la migration 026 (sans appareilId) restent valides
    // — sinon le déploiement déconnecterait tout le monde d'un coup. La
    // révocation (bouton « Déconnecter » sur un appareil) n'est donc réelle
    // que pour les sessions ouvertes après cette migration.
    const [rows] = await pool.execute(
      `SELECT u.alanyaID, u.alanyaPhone, u.email
       FROM users u
       LEFT JOIN appareils a ON a.id = ? AND a.alanyaID = u.alanyaID
       WHERE u.alanyaID = ? AND u.exclus = 0 AND (a.id IS NULL OR a.revoked_at IS NULL)`,
      [decoded.appareilId ?? null, decoded.alanyaID]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Utilisateur non trouvé, banni ou appareil déconnecté' });
    }

    req.user = {
      alanyaID: rows[0].alanyaID,
      phone: rows[0].alanyaPhone,
      email: rows[0].email,
      appareilId: decoded.appareilId ?? null,
    };
    next();
  } catch (error) {
    console.error('[Auth] ERROR:', error.message);
    return res.status(401).json({ error: 'Échec d\'authentification' });
  }
};

module.exports = auth;