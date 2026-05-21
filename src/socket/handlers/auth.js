const jwt  = require('jsonwebtoken');
const pool = require('../../config/db');

const JWT_SECRET = process.env.JWT_SECRET || 'talky-secret-key-change-in-production';

const socketAuth = (io, socket, userSockets) => {

  socket.on('auth:login', async (data) => {
    try {
      const { token } = data || {};
      if (!token) {
        return socket.emit('auth:error', { message: 'Token requis' });
      }

      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET);
      } catch (err) {
        if (err.name === 'TokenExpiredError') {
          return socket.emit('auth:error', { message: 'Token expiré', code: 'TOKEN_EXPIRED' });
        }
        return socket.emit('auth:error', { message: 'Token invalide' });
      }

      if (decoded.type !== 'access') {
        return socket.emit('auth:error', { message: 'Type de token invalide' });
      }

      const [rows] = await pool.execute(
        'SELECT alanyaID, alanyaPhone FROM users WHERE alanyaID = ? AND exclus = 0',
        [decoded.alanyaID]
      );

      if (rows.length === 0) {
        return socket.emit('auth:error', { message: 'Utilisateur introuvable ou banni' });
      }

      const alanyaID = rows[0].alanyaID;
      _registerSocket(socket, alanyaID, userSockets, io);
      console.log(`[Socket] Authentifié: User ${alanyaID} (socket ${socket.id})`);

    } catch (error) {
      console.error('[Socket auth:login]', error.message);
      socket.emit('auth:error', { message: 'Erreur d\'authentification' });
    }
  });
};

function _registerSocket(socket, alanyaID, userSockets, io) {
  socket.alanyaID      = alanyaID;
  socket.authenticated = true;

  const existingSocketId = userSockets.get(alanyaID);
  if (existingSocketId && existingSocketId !== socket.id) {
    const existingSocket = io.sockets.sockets.get(existingSocketId);
    if (existingSocket) {
      existingSocket.emit('auth:conflict', { message: 'Connexion depuis un autre appareil' });
    }
  }

  userSockets.set(alanyaID, socket.id);
  socket.join(`user_${alanyaID}`);
  socket.emit('auth:verified', { success: true, alanyaID });
}

module.exports = socketAuth;