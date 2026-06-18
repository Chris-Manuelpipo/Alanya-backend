const bcrypt = require('bcryptjs');
const pool = require('../../config/db');
const {
  generateAccessToken,
  generateRefreshToken,
} = require('../../middleware/authCustom');
 
// Login admin  dédié web : email + password, refuse type_compte = 0
const adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }

    const [rows] = await pool.execute(
      `SELECT alanyaID, nom, pseudo, alanyaPhone, email, password,
              avatar_url, type_compte, exclus
       FROM users WHERE email = ?`,
      [email.toLowerCase().trim()]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }
    const u = rows[0];
    if (u.exclus === 1) {
      return res.status(403).json({ error: 'Compte banni' });
    }
    if ((u.type_compte ?? 0) < 1) {
      return res.status(403).json({ error: 'Accès admin requis' });
    }

    const ok = await bcrypt.compare(password, u.password);
    if (!ok) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    const payload = { alanyaID: u.alanyaID, email: u.email };
    res.json({
      accessToken: generateAccessToken(payload),
      refreshToken: generateRefreshToken(payload),
      user: {
        alanyaID: u.alanyaID,
        nom: u.nom,
        pseudo: u.pseudo,
        email: u.email,
        alanyaPhone: u.alanyaPhone,
        avatar_url: u.avatar_url,
        type_compte: u.type_compte,
      },
    });
  } catch (error) {
    console.error('[Admin] login error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { adminLogin };
