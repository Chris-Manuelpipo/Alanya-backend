const jwt  = require('jsonwebtoken');
const pool = require('../../config/db');
const pendingCalls = require('../state/pendingCalls');
const { registerUserSocket } = require('../../utils/userSocketRegistry');

const JWT_SECRET = process.env.JWT_SECRET || 'talky-secret-key-change-in-production';
const REPLAY_ENABLED = process.env.ENABLE_PENDING_CALL_REPLAY !== 'false';

const socketAuth = (io, socket, userSockets) => {

  socket.on('auth:login', async (data) => {
    try {
      const { token, deviceId, device_ID: deviceIdSnake } = data || {};
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
      const rawDevice = deviceId ?? deviceIdSnake;
      if (rawDevice && String(rawDevice).trim()) {
        socket.deviceId = String(rawDevice).trim().slice(0, 128);
      }
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

  registerUserSocket(userSockets, alanyaID, socket.id);
  socket.join(`user_${alanyaID}`);
  socket.emit('auth:verified', { success: true, alanyaID });

  // Rejeu d'un appel entrant en attente : si l'utilisateur vient d'être réveillé
  // par un push FCM (app fermée), l'event `incoming_call` initial a été perdu.
  // On le lui rejoue maintenant que son socket est authentifié, avec l'offre WebRTC.
  if (!REPLAY_ENABLED) {
    pendingCalls.clear(alanyaID);
    console.log(`[PhantomCallFix] pending:replay-disabled target=${alanyaID}`);
    return;
  }

  const pending = pendingCalls.getReplayable(alanyaID);
  if (pending) {
    console.log(`[Socket] !! Rejeu incoming_call à User ${alanyaID} (appel en attente)`);
    socket.emit('incoming_call', pending);
    const delivery = pendingCalls.markDelivered(alanyaID, 'auth-replay');
    if (delivery) {
      console.log(
        `[PhantomCallFix] pending:replay target=${alanyaID} callId=${delivery.callId ?? 'none'} attempts=${delivery.attempts}`,
      );
    }
    pendingCalls.clear(alanyaID);
  } else {
    console.log(`[PhantomCallFix] pending:skip-replay target=${alanyaID}`);
  }
}

module.exports = socketAuth;