const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { ALL_PERMISSIONS, can } = require('../constants/adminRoles');

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

/**
 * Exige une permission nommée. À utiliser APRÈS `adminAuth`.
 *
 * Remplace la lecture d'un niveau par la déclaration d'une intention : une
 * route dit `requirePermission('users.ban')` au lieu de `superAdminAuth`, et
 * « qui a le droit de bannir ? » se répond en lisant `constants/adminRoles.js`
 * plutôt que les 54 lignes du routeur.
 *
 * Aucune requête supplémentaire : `adminAuth` a déjà relu `type_compte` en
 * base — jamais depuis le jeton, dont la copie peut être périmée.
 *
 * Une permission inconnue lève au chargement du module et non à l'appel : une
 * faute de frappe ouvrirait sinon la route à tout le monde ou à personne, sans
 * bruit, jusqu'à ce que quelqu'un s'en aperçoive en production.
 */
const requirePermission = (permission) => {
  if (!ALL_PERMISSIONS.has(permission)) {
    throw new Error(`[adminAuth] permission inconnue : ${permission}`);
  }

  const guard = (req, res, next) => {
    if (!req.user || !can(req.user.typeCompte, permission)) {
      return res.status(403).json({ error: 'Permission requise', permission });
    }
    next();
  };

  // Lisible depuis la pile du routeur : c'est ce qui permet au test de vérifier
  // qu'aucune route n'a été oubliée.
  guard.permission = permission;
  return guard;
};

module.exports = { adminAuth, superAdminAuth, requirePermission };
