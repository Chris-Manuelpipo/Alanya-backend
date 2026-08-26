const jwt = require('jsonwebtoken');
const pool = require('../../config/db');
const { can } = require('../../constants/adminRoles');

const JWT_SECRET = process.env.JWT_SECRET || 'talky-secret-key-change-in-production';

/** Salon d'équipe. Suit la convention des salons `user_<id>` existants. */
const ADMIN_ROOM = 'admin_ops';

/**
 * Canal temps réel du back-office.
 *
 * Le panneau n'avait aucun socket : tout était obtenu par sondage. Or un trajet
 * qui bascule en `sos` ou en `alert`, c'est quelqu'un en difficulté maintenant,
 * et l'information arrivait au prochain rafraîchissement — si une page était
 * ouverte.
 *
 * Le rôle est relu en base et jamais tiré du jeton : un compte rétrogradé garde
 * un access token valide jusqu'à son expiration, et c'est exactement la fenêtre
 * pendant laquelle il ne doit plus recevoir d'alertes.
 */
const adminOps = (io, socket) => {
  socket.on('admin:login', async (data) => {
    try {
      const token = data?.token;
      if (!token) return socket.emit('admin:error', { message: 'Token requis' });

      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET);
      } catch (err) {
        return socket.emit('admin:error', {
          message: err.name === 'TokenExpiredError' ? 'Token expiré' : 'Token invalide',
          code: err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : undefined,
        });
      }

      if (decoded.type !== 'access') {
        return socket.emit('admin:error', { message: 'Type de token invalide' });
      }

      const [rows] = await pool.execute(
        'SELECT type_compte FROM users WHERE alanyaID = ? AND exclus = 0',
        [decoded.alanyaID],
      );
      const typeCompte = rows[0]?.type_compte;
      // La même permission que la page Trajets : qui peut lire les compteurs
      // peut être prévenu quand l'un d'eux bascule.
      if (!can(typeCompte, 'trips.read')) {
        return socket.emit('admin:error', { message: 'Accès admin requis' });
      }

      socket.join(ADMIN_ROOM);
      socket.data.adminId = decoded.alanyaID;
      socket.emit('admin:ready', { room: ADMIN_ROOM });
    } catch (error) {
      console.error('[AdminOps] auth:', error.message);
      socket.emit('admin:error', { message: 'Erreur d’authentification' });
    }
  });
};

/**
 * Prévient l'équipe. Sans effet si personne n'écoute — l'appelant ne doit
 * jamais échouer parce qu'aucun administrateur n'a le panneau ouvert.
 *
 * `io` est récupéré paresseusement : les services qui émettent n'ont pas de
 * référence au serveur socket au moment de leur chargement.
 */
function notifyAdmins(io, event, payload) {
  try {
    if (!io) return;
    io.to(ADMIN_ROOM).emit(event, { ...payload, at: new Date().toISOString() });
  } catch (e) {
    console.error('[AdminOps] émission échouée:', e.message);
  }
}

module.exports = { adminOps, notifyAdmins, ADMIN_ROOM };
