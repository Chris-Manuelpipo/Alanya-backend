const pool = require('../../config/db');
const bcrypt = require('bcryptjs');
const { sendDataOnlyNotification } = require('../../services/notificationService');

const SALT_ROUNDS = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * GET /api/admin/me
 * Retourne le profil complet de l'admin connecté.
 */
async function getMe(req, res) {
  try {
    const [rows] = await pool.execute(
      `SELECT u.alanyaID, u.nom, u.pseudo, u.email, u.alanyaPhone,
              u.avatar_url, u.type_compte, u.created_at, u.last_seen,
              p.libelle AS pays_libelle
       FROM users u
       LEFT JOIN pays p ON u.idPays = p.idPays
       WHERE u.alanyaID = ?`,
      [req.user.alanyaID]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Profil introuvable' });
    }

    const u = rows[0];
    res.json({
      alanyaID: u.alanyaID,
      nom: u.nom,
      pseudo: u.pseudo,
      email: u.email,
      alanyaPhone: u.alanyaPhone,
      avatarUrl: u.avatar_url,
      typeCompte: u.type_compte ?? 0,
      paysLibelle: u.pays_libelle,
      createdAt: u.created_at,
      lastSeen: u.last_seen,
    });
  } catch (error) {
    console.error('[AdminProfile] getMe error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

/**
 * PUT /api/admin/me
 * Met à jour le profil (nom, pseudo, email, avatar_url).
 */
async function updateMe(req, res) {
  try {
    const { nom, pseudo, email, avatarUrl, idPays } = req.body;
    const updates = [];
    const values = [];

    if (nom !== undefined) {
      if (!nom.trim()) return res.status(400).json({ error: 'Le nom ne peut pas être vide' });
      updates.push('nom = ?');
      values.push(nom.trim());
    }

    if (pseudo !== undefined) {
      if (!pseudo.trim()) return res.status(400).json({ error: 'Le pseudo ne peut pas être vide' });
      updates.push('pseudo = ?');
      values.push(pseudo.trim());
    }

    if (email !== undefined) {
      if (email && !EMAIL_RE.test(email)) {
        return res.status(400).json({ error: 'Adresse email invalide' });
      }
      if (email) {
        const normalizedEmail = email.toLowerCase().trim();
        const [existing] = await pool.execute(
          'SELECT alanyaID FROM users WHERE email = ? AND alanyaID != ?',
          [normalizedEmail, req.user.alanyaID]
        );
        if (existing.length > 0) {
          return res.status(409).json({ error: 'Cette adresse email est déjà utilisée' });
        }
        updates.push('email = ?');
        values.push(normalizedEmail);
      } else {
        updates.push('email = NULL');
      }
    }

    if (avatarUrl !== undefined) {
      updates.push('avatar_url = ?');
      values.push(avatarUrl || 'NON DEFINI');
    }

    if (idPays !== undefined) {
      if (idPays) {
        const [country] = await pool.execute('SELECT idPays FROM pays WHERE idPays = ?', [idPays]);
        if (country.length === 0) {
          return res.status(400).json({ error: 'Pays invalide' });
        }
      }
      updates.push('idPays = ?');
      values.push(idPays || null);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Aucun champ à modifier' });
    }

    values.push(req.user.alanyaID);
    await pool.execute(
      `UPDATE users SET ${updates.join(', ')} WHERE alanyaID = ?`,
      values
    );

    // Retourner le profil mis à jour
    const [rows] = await pool.execute(
      `SELECT u.alanyaID, u.nom, u.pseudo, u.email, u.alanyaPhone,
              u.avatar_url, u.type_compte, u.created_at, u.last_seen,
              p.libelle AS pays_libelle
       FROM users u
       LEFT JOIN pays p ON u.idPays = p.idPays
       WHERE u.alanyaID = ?`,
      [req.user.alanyaID]
    );

    const u = rows[0];

    // Mettre à jour le localStorage côté client si email ou nom changent
    res.json({
      alanyaID: u.alanyaID,
      nom: u.nom,
      pseudo: u.pseudo,
      email: u.email,
      alanyaPhone: u.alanyaPhone,
      avatarUrl: u.avatar_url,
      typeCompte: u.type_compte ?? 0,
      paysLibelle: u.pays_libelle,
      createdAt: u.created_at,
      lastSeen: u.last_seen,
    });
  } catch (error) {
    console.error('[AdminProfile] updateMe error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

/**
 * PUT /api/admin/me/password
 * Change le mot de passe de l'admin connecté.
 * Notifie tous les super-admins via Socket.IO + FCM.
 */
async function updatePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Mot de passe actuel et nouveau mot de passe requis' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 6 caractères' });
    }

    // Récupérer le hash actuel
    const [rows] = await pool.execute(
      'SELECT alanyaID, nom, password FROM users WHERE alanyaID = ?',
      [req.user.alanyaID]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur introuvable' });
    }

    const user = rows[0];

    // Vérifier l'ancien mot de passe
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
    }

    // Hasher et mettre à jour
    const hashed = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await pool.execute('UPDATE users SET password = ? WHERE alanyaID = ?', [hashed, req.user.alanyaID]);

    // Notifier tous les super-admins
    try {
      const [superAdmins] = await pool.execute(
        `SELECT alanyaID, nom, fcm_token FROM users
         WHERE type_compte = 2 AND exclus = 0`
      );

      const io = req.app.get('io');
      const notificationPayload = {
        type: 'admin:password_changed',
        title: 'Mot de passe modifié',
        body: `${user.nom} a changé son mot de passe`,
        actorId: req.user.alanyaID,
        actorNom: user.nom,
        timestamp: new Date().toISOString(),
      };

      for (const sa of superAdmins) {
        // Socket.IO
        if (io) {
          io.to(`user_${sa.alanyaID}`).emit('admin:notification', notificationPayload);
        }
        // FCM
        if (sa.fcm_token && sa.fcm_token !== 'INDEFINI') {
          sendDataOnlyNotification(sa.fcm_token, {
            type: 'admin_notification',
            title: 'Mot de passe modifié',
            body: `${user.nom} a changé son mot de passe`,
            actorNom: user.nom,
          }).catch(() => {});
        }
      }
    } catch (notifErr) {
      console.error('[AdminProfile] Notification error (non-blocking):', notifErr.message);
    }

    res.json({ message: 'Mot de passe modifié avec succès' });
  } catch (error) {
    console.error('[AdminProfile] updatePassword error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

module.exports = { getMe, updateMe, updatePassword };
