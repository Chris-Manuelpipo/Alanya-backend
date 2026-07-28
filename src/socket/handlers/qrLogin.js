const { secretMatches } = require('../../utils/qrToken');
const qrLoginSessions = require('../state/qrLoginSessions');


/**
 * Écoute d'une session de connexion par QR.
 *
 * Seul handler du serveur à déroger à la garde `if (!socket.authenticated)` :
 * l'appareil qui affiche le QR n'est, par construction, pas encore connecté —
 * il ne peut donc pas s'authentifier avant d'écouter sa propre session.
 *
 * L'exception est bornée par construction :
 *   - la seule room accessible est `qr_session_<sessionId>`, et uniquement sur
 *     présentation du pollToken, qui n'est JAMAIS dans le QR (il n'a été remis
 *     qu'à l'appareil ayant créé la session) — photographier le QR ne suffit
 *     donc pas à entrer ;
 *   - le socket ne devient jamais `authenticated`, ne rejoint jamais `user_*`
 *     et n'obtient donc aucun autre event du serveur ;
 *   - la room ne transporte que le statut, jamais de token : la livraison des
 *     tokens reste sur le poll HTTP, à usage unique ;
 *   - la session s'auto-détruit au bout de 90 s.
 */
const qrSessionJoin = (io, socket) => {
  socket.on('qr_session:join', (data) => {
    try {
      const { sessionId, pollToken } = data || {};
      if (!sessionId || !pollToken) return;

      const entry = qrLoginSessions.get(String(sessionId));
      if (!entry || !secretMatches(pollToken, entry.pollToken)) return;

      socket.join(`qr_session_${entry.sessionId}`);
      socket.emit('qr_session:update', {
        sessionId: entry.sessionId,
        status: entry.status,
      });
    } catch (error) {
      console.error('[Socket qr_session:join]', error.message);
    }
  });
};

module.exports = qrSessionJoin;
