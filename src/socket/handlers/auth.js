const jwt  = require('jsonwebtoken');
const pool = require('../../config/db');
const pendingCalls = require('../state/pendingCalls');
const callState = require('../state/callState');
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

      // Même garde que le middleware HTTP (migration 026) : sans elle, un
      // appareil révoqué verrait toutes ses requêtes REST en 401 mais garderait
      // une socket authentifiée, donc les messages et les appels en temps réel,
      // jusqu'à l'expiration de son access token. Les tokens antérieurs à la
      // migration (sans appareilId) restent acceptés.
      const [rows] = await pool.execute(
        `SELECT u.alanyaID, u.alanyaPhone
         FROM users u
         LEFT JOIN appareils a ON a.id = ? AND a.alanyaID = u.alanyaID
         WHERE u.alanyaID = ? AND u.exclus = 0 AND (a.id IS NULL OR a.revoked_at IS NULL)`,
        [decoded.appareilId ?? null, decoded.alanyaID]
      );

      if (rows.length === 0) {
        return socket.emit('auth:error', { message: 'Utilisateur introuvable, banni ou appareil déconnecté' });
      }

      const alanyaID = rows[0].alanyaID;
      const rawDevice = deviceId ?? deviceIdSnake;
      if (rawDevice && String(rawDevice).trim()) {
        socket.deviceId = String(rawDevice).trim().slice(0, 128);
      }
      // Clé de la déconnexion forcée à la révocation : `socket.deviceId` est
      // l'UUID applicatif du client, pas l'identifiant matériel de
      // `appareils.device_id` — seul `appareilId` désigne la même ligne des
      // deux côtés.
      socket.appareilId = decoded.appareilId ?? null;
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
  // Une socket authentifiée n'est PAS en ligne tant qu'elle ne l'a pas déclaré
  // via `presence:online` : l'app peut se (re)connecter en arrière-plan, par
  // exemple réveillée par une push d'appel.
  socket.isForeground  = false;

  registerUserSocket(userSockets, alanyaID, socket.id);
  socket.join(`user_${alanyaID}`);
  socket.emit('auth:verified', { success: true, alanyaID });

  // Reconnexion pendant un appel en cours (grace period après kill app).
  callState.cancelDisconnectGrace(alanyaID);
  const activeCall = callState.getEntry(alanyaID);
  if (activeCall?.status === 'in_call') {
    const peerId = activeCall.peerId;
    const payload = {
      callId: activeCall.callId,
      peerId: peerId != null ? String(peerId) : null,
      status: 'in_call',
      isVideo: !!activeCall.isVideo,
      role: activeCall.lastAnswer != null ? 'caller' : 'callee',
      answer: activeCall.lastAnswer ?? null,
    };
    console.log(`[Socket] call_resume user=${alanyaID} callId=${payload.callId ?? 'none'}`);
    socket.emit('call_resume', payload);
  }

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
    // Garde autoritaire : ne rejouer que si l'appel est TOUJOURS en sonnerie pour
    // ce callId côté callState. Sinon (refusé / terminé / timeout, ou tout état
    // désynchronisé du buffer) on purge et on ne rejoue pas un écran fantôme.
    const entry = callState.getEntry(alanyaID);
    const stillRinging =
      !!entry &&
      entry.status === 'ringing' &&
      (pending.callId == null || String(entry.callId) === String(pending.callId));

    if (!stillRinging) {
      console.log(
        `[PhantomCallFix] pending:stale-skip target=${alanyaID} status=${entry?.status ?? 'idle'} callId=${pending.callId ?? 'none'}`,
      );
      pendingCalls.clear(alanyaID);
    } else {
      console.log(`[Socket] !! Rejeu incoming_call à User ${alanyaID} (appel en attente)`);
      socket.emit('incoming_call', pending);
      const delivery = pendingCalls.markDelivered(alanyaID, 'auth-replay');
      if (delivery) {
        console.log(
          `[PhantomCallFix] pending:replay target=${alanyaID} callId=${delivery.callId ?? 'none'} attempts=${delivery.attempts}`,
        );
      }
      pendingCalls.clear(alanyaID);
    }
  } else {
    console.log(`[PhantomCallFix] pending:skip-replay target=${alanyaID}`);
  }
}

module.exports = socketAuth;