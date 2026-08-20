require('dotenv').config();

// ── Firebase Admin — initialisé EN PREMIER avant tout autre require ───
require('./src/config/firebase');

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const path       = require('path');

const errorHandler = require('./src/middleware/errorHandler');
const { generalLimiter } = require('./src/middleware/rateLimiter');

const swaggerUi   = require('swagger-ui-express');
const swaggerSpec = require('./src/config/swagger');

// ── Routes ────────────────────────────────────────────────────────────
const authCustomRoutes   = require('./src/routes/authCustom');
const paysRoutes         = require('./src/routes/pays');
const userRoutes         = require('./src/routes/users');
const conversationRoutes = require('./src/routes/conversations');
const messageRoutes      = require('./src/routes/messages');
const messageOpsRoutes   = require('./src/routes/messageOps');
const statusRoutes       = require('./src/routes/status');
const callRoutes         = require('./src/routes/calls');
const meetingRoutes      = require('./src/routes/meetings');
const notifyRoutes       = require('./src/routes/notify');
const uploadRoutes       = require('./src/routes/upload');
const contactRoutes      = require('./src/routes/contacts');
const contactListRoutes  = require('./src/routes/contactLists');
const tripRoutes         = require('./src/routes/trips');
const qrRoutes           = require('./src/routes/qr');
const turnRoutes         = require('./src/routes/turn');
const mapRoutes          = require('./src/routes/mapTiles');
const adminRoutes        = require('./src/routes/admin');
const welcomeRoutes      = require('./src/routes/welcome');
const qrLandingRoutes    = require('./src/routes/qrLanding');

// ── Socket handlers ───────────────────────────────────────────────────
const socketAuth = require('./src/socket/handlers/auth');
const qrLoginSocket = require('./src/socket/handlers/qrLogin');
const {
  joinConversation, messageSend, typingStart, typingStop,
  messageDelivered, messageRead,
  presenceOnline, presenceOffline, handleDisconnect,
} = require('./src/socket/handlers/chat');

const {
  tripSubscribe, tripUnsubscribe, tripPosition, tripPositionBatch,
  tripClaimDevice, tripSignal, tripSeen,
} = require('./src/socket/handlers/trips');

const {
  callUser, answerCall, rejectCall, iceCandidate, endCall,
  addParticipant, cancelAddParticipant, confJoin, confReject,
  confReady,
  createGroupCall, joinGroupCall, leaveGroupCall, endGroupCall,
  groupOffer, groupAnswer, groupIceCandidate,
  callMuteState, groupMuteState, callVideoState, groupVideoState,
  callResumeHandshake, callRejoin,
} = require('./src/socket/handlers/calls');

const {
  meetingCreate, meetingJoinRoom, meetingJoinRequest,
  meetingJoinAccept, meetingJoinDecline,
  meetingStart, meetingEnd, meetingChat,
  meetingLeave, meetingOffer, meetingAnswer, meetingIceCandidate,
  meetingMuteState, meetingVideoState,
} = require('./src/socket/handlers/meetings');

const { startMeetingScheduler, stopMeetingScheduler } = require('./src/services/meetingScheduler');
const { startAccountLifecycleSchedulers } = require('./src/controllers/accountLifecycleController');
const { initBroadcastCache, runNightlyDeliveryMaintenance } = require('./src/services/broadcastService');
const { registerBroadcastJobHandlers } = require('./src/services/broadcastWorkers');
const { registerWelcomeJobHandlers } = require('./src/services/welcomeWorkers');
const { purgeExpiredWelcomeStatuses } = require('./src/services/welcomeService');
const { startJobWorker, stopJobWorker } = require('./src/services/jobQueue');
const { startVerificationScheduler, stopVerificationScheduler } = require('./src/services/verificationScheduler');
const { withLease } = require('./src/services/schedulerLease');
const { runDataRetentionPurge } = require('./src/services/dataRetentionService');
const {
  registerTripJobHandlers, setIo: setTripIo,
} = require('./src/services/tripWorkers');
const { runNightlyTripPurge } = require('./src/services/tripRetention');

let stopAccountLifecycleSchedulers = () => {};

// ── App ───────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const { createUserSocketRegistry } = require('./src/utils/userSocketRegistry');
const userSockets = createUserSocketRegistry();

app.set('trust proxy', 1);
app.set('io', io);
app.set('userSockets', userSockets);

app.use(cors());
app.use(express.json());
app.use(generalLimiter);
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Servir les fichiers uploadés statiquement.
// Les noms de fichiers sont uniques (`media_<alanyaID>_<timestamp>.<ext>`),
// donc une URL donnée pointe toujours vers le même contenu : on autorise les
// caches HTTP (et flutter_cache_manager côté app) à conserver la réponse sans
// revalidation. Sans cela, chaque retour dans un écran (chat, Mes médias)
// re-téléchargeait les médias déjà vus.
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));

// ── Routes API ────────────────────────────────────────────────────────
app.use('/api/auth',          authCustomRoutes);
app.use('/api/pays',          paysRoutes);
app.use('/api/users',         userRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/conversations', messageRoutes);
app.use('/api/messages',      messageOpsRoutes);
app.use('/api/status',        statusRoutes);
app.use('/api/calls',         callRoutes);
app.use('/api/meetings',      meetingRoutes);
app.use('/api/upload',        uploadRoutes);
app.use('/api/contacts',      contactRoutes);
app.use('/api/contact-lists', contactListRoutes);
app.use('/api/trips', tripRoutes);
app.use('/api/qr',            qrRoutes);
app.use('/api/turn',          turnRoutes);
app.use('/api/map',           mapRoutes);
app.use('/api/admin',         adminRoutes);
app.use('/api/welcome',       welcomeRoutes);
app.use('/notify',            notifyRoutes);

// Routes publiques du volet QR (page d'accueil d'un code, fichiers
// d'association des liens universels) — à la racine du domaine, hors /api :
// c'est cette URL qui est encodée dans les QR d'identité et partagée.
app.use('/', qrLandingRoutes);

app.get('/health', (_, res) => res.json({ status: 'Serveur ok', timestamp: new Date().toISOString() }));

app.use(errorHandler);

// ── Socket.IO ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[Socket] Client connecté:', socket.id);

  socket.authenticated = false;

  socketAuth(io, socket, userSockets);
  qrLoginSocket(io, socket, userSockets);
  presenceOnline(io, socket, userSockets);
  presenceOffline(io, socket, userSockets);
  joinConversation(io, socket, userSockets);
  messageSend(io, socket, userSockets);
  typingStart(io, socket, userSockets);
  typingStop(io, socket, userSockets);
  messageDelivered(io, socket, userSockets);
  messageRead(io, socket, userSockets);
  tripSubscribe(io, socket, userSockets);
  tripUnsubscribe(io, socket, userSockets);
  tripPosition(io, socket, userSockets);
  tripPositionBatch(io, socket, userSockets);
  tripClaimDevice(io, socket, userSockets);
  tripSignal(io, socket, userSockets);
  tripSeen(io, socket, userSockets);
  callUser(io, socket, userSockets);
  answerCall(io, socket, userSockets);
  rejectCall(io, socket, userSockets);
  iceCandidate(io, socket, userSockets);
  endCall(io, socket, userSockets);
  addParticipant(io, socket, userSockets);
  cancelAddParticipant(io, socket, userSockets);
  confJoin(io, socket, userSockets);
  confReject(io, socket, userSockets);
  confReady(io, socket, userSockets);
  createGroupCall(io, socket, userSockets);
  joinGroupCall(io, socket, userSockets);
  leaveGroupCall(io, socket, userSockets);
  endGroupCall(io, socket, userSockets);
  groupOffer(io, socket, userSockets);
  groupAnswer(io, socket, userSockets);
  groupIceCandidate(io, socket, userSockets);
  callMuteState(io, socket, userSockets);
  groupMuteState(io, socket, userSockets);
  callVideoState(io, socket, userSockets);
  groupVideoState(io, socket, userSockets);
  callResumeHandshake(io, socket, userSockets);
  callRejoin(io, socket, userSockets);
  meetingCreate(io, socket, userSockets);
  meetingJoinRoom(io, socket, userSockets);
  meetingJoinRequest(io, socket, userSockets);
  meetingJoinAccept(io, socket, userSockets);
  meetingJoinDecline(io, socket, userSockets);
  meetingStart(io, socket, userSockets);
  meetingEnd(io, socket, userSockets);
  meetingChat(io, socket, userSockets);
  meetingLeave(io, socket, userSockets);
  meetingOffer(io, socket, userSockets);
  meetingAnswer(io, socket, userSockets);
  meetingIceCandidate(io, socket, userSockets);
  meetingMuteState(io, socket, userSockets);
  meetingVideoState(io, socket, userSockets);

  socket.on('disconnect', async () => {
    console.log('[Socket] Client déconnecté:', socket.id);
    await handleDisconnect(io, socket, userSockets);
  });
});

/**
 * La présence vit dans la mémoire du process (registre des sockets). Après un
 * crash ou un redéploiement, ce registre est vide mais les lignes
 * `users.is_online = 1` survivent : sans ce ménage, ces comptes resteraient
 * « en ligne » indéfiniment, y compris dans les statistiques admin.
 */
const resetStalePresence = async () => {
  try {
    const pool = require('./src/config/db');
    const [res] = await pool.execute(
      'UPDATE users SET is_online = 0 WHERE is_online = 1',
    );
    if (res.affectedRows > 0) {
      console.log(`[Presence] ${res.affectedRows} présence(s) fantôme(s) nettoyée(s) au démarrage`);
    }
  } catch (e) {
    console.error('[Presence] reset au démarrage échoué:', e.code || '', e.message);
  }
};

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur en marche sur le port ${PORT}`);
  resetStalePresence();
  registerBroadcastJobHandlers();
  registerWelcomeJobHandlers();
  // Les jobs de trajet tournent hors requête : ils n'ont pas accès à
  // req.app.get('io'), il faut donc le leur donner explicitement.
  setTripIo(io);
  registerTripJobHandlers();
  initBroadcastCache().catch((e) => console.error('[Broadcast] init cache:', e.message));
  startJobWorker();
  startMeetingScheduler();
  startVerificationScheduler();
  stopAccountLifecycleSchedulers = startAccountLifecycleSchedulers();

  setInterval(() => {
    withLease('broadcast_nightly_purge', () => runNightlyDeliveryMaintenance()).catch(
      (e) => console.error('[Broadcast] nightly:', e.message),
    );
    // Sans cette purge, `statut` grossit d'une ligne par inscription et ne
    // rétrécit jamais : l'app cesse d'afficher un statut expiré, mais rien ne
    // le supprimait.
    withLease('welcome_status_purge', () => purgeExpiredWelcomeStatuses()).catch(
      (e) => console.error('[Welcome] purge statuts:', e.message),
    );
    // Trace GPS : 30 jours après clôture (TRIP_POINTS_RETENTION_H), autant si
    // le trajet s'est clos sur une alerte. Sans cette purge, `trip_point`
    // deviendrait un registre permanent des déplacements de tous les
    // utilisateurs. L'admin peut la déclencher à la main, mais rien ne dépend
    // de lui : ce balayage suffit.
    withLease('trip_nightly_purge', () => runNightlyTripPurge()).catch(
      (e) => console.error('[Trips] purge:', e.message),
    );
    // Statuts ordinaires expirés, historique d'appels, journal de connexions,
    // jobs en échec terminal, appareils révoqués, OTP abandonnés — aucune de
    // ces tables n'était purgée avant (audit scalabilité 06/08/2026 §2.5).
    withLease('data_retention_purge', () => runDataRetentionPurge()).catch(
      (e) => console.error('[DataRetention] purge:', e.message),
    );
  }, 24 * 60 * 60 * 1000);
});

// Filet de dernier recours. Express 4 ne capture PAS le rejet d'un handler
// `async` : toute erreur non rattrapée y remonte en unhandled rejection, et
// Node >= 18 termine le process par défaut. Une seule requête malformée
// suffisait donc à tuer le serveur entier — toutes les sockets tombent, tous
// les appels en cours coupent.
//
// Les handlers doivent passer par `next(error)` pour atteindre `errorHandler` ;
// ceci ne les en dispense pas, mais garantit qu'un oubli dégrade une requête
// au lieu d'abattre le service. La trace est complète pour que l'oubli se
// corrige.
process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection] requête dégradée, process préservé :',
    reason instanceof Error ? reason.stack : reason);
});

process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err?.stack || err);
});

process.on('SIGINT', () => {
  console.log('Arrêt du serveur...');
  stopMeetingScheduler();
  stopVerificationScheduler();
  stopJobWorker();
  stopAccountLifecycleSchedulers();
  process.exit(0);
});

module.exports = { app, server, io };