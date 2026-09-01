require('dotenv').config();

// ── Firebase Admin — initialisé EN PREMIER avant tout autre require ───
require('./src/config/firebase');

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const cors       = require('cors');
const path       = require('path');
const { REDIS_ENABLED, REDIS_URL, createRedisClient, connectWithTimeout } = require('./src/config/redis');
const { setDataClient } = require('./src/config/redisData');

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
const backupRoutes       = require('./src/routes/backup');
const mediaAvailRoutes   = require('./src/routes/mediaAvailability');
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
const { runPurgeIfEnabled } = require('./src/services/purgeRegistry');
const {
  registerTripJobHandlers, setIo: setTripIo,
} = require('./src/services/tripWorkers');
const {
  registerCallStateJobHandlers, setIo: setCallStateIo, setUserSockets: setCallStateUserSockets,
} = require('./src/services/callStateWorkers');
const {
  registerMeetingJobHandlers, setIo: setMeetingIo,
} = require('./src/services/meetingWorkers');
const { runNightlyTripPurge } = require('./src/services/tripRetention');
const { runNightlyMediaPurge } = require('./src/services/mediaRetention');
const { mediaExpiryGuard, staticHeaders } = require('./src/middleware/mediaExpiry');

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
//
// Le garde d'expiration passe AVANT : sur un média partitionné, le chemin
// porte le jour de l'upload, donc l'expiration se tranche sans ouvrir le
// moindre fichier ni interroger la base. Il répond alors `410 Gone`, que le
// client sait distinguer d'une panne réseau — un 404 laisserait croire à un
// incident passager et l'app réessaierait indéfiniment. Le même garde relaie
// les anciennes adresses vers la partition d'un fichier déplacé, ce qui évite
// tout `UPDATE` de masse sur `message.mediaUrl`.
//
// `staticHeaders` plafonne en outre le `max-age` à la vie restante de la
// partition : sans ça un cache intermédiaire garderait un an une URL qui meurt
// dans trois jours, et le 410 n'atteindrait jamais le client.
app.use('/uploads', mediaExpiryGuard());
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  setHeaders: staticHeaders(),
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
app.use('/api/backup',        backupRoutes);
app.use('/api/media',         mediaAvailRoutes);
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
 * `user_presence.is_online = 1` survivent : sans ce ménage, ces comptes
 * resteraient « en ligne » indéfiniment, y compris dans les statistiques
 * admin.
 */
const resetStalePresence = async () => {
  try {
    const pool = require('./src/config/db');
    const [res] = await pool.execute(
      'UPDATE user_presence SET is_online = 0 WHERE is_online = 1',
    );
    if (res.affectedRows > 0) {
      console.log(`[Presence] ${res.affectedRows} présence(s) fantôme(s) nettoyée(s) au démarrage`);
    }
  } catch (e) {
    console.error('[Presence] reset au démarrage échoué:', e.code || '', e.message);
  }
};

const PORT = process.env.PORT || 3000;

/**
 * Adapter Socket.IO Redis (intégration Redis phase 1) : sans lui,
 * `io.to(room).emit()` n'atteint que les sockets connectées à CE process —
 * bloquant pour tout passage à `pm2 -i > 1`. `REDIS_URL` absent : aucun
 * changement de comportement, adapter en mémoire. `REDIS_URL` injoignable au
 * démarrage : on préfère un échec bruyant à un serveur qui tourne en pensant
 * émettre cluster-wide alors que ce n'est pas le cas.
 */
async function start() {
  if (REDIS_ENABLED) {
    const pubClient = createRedisClient('pub');
    const subClient = pubClient.duplicate();
    subClient.on('error', (e) => console.error('[Redis:sub] erreur:', e.message));
    // Client « data » (état applicatif : pendingCalls, callDeviceOwnership,
    // callState, …) — distinct du pub/sub ci-dessus, réservé au protocole de
    // l'adapter Socket.IO. Voir src/config/redisData.js.
    const dataClient = createRedisClient('data');
    try {
      await Promise.all([
        connectWithTimeout(pubClient, 5000, 'pub'),
        connectWithTimeout(subClient, 5000, 'sub'),
        connectWithTimeout(dataClient, 5000, 'data'),
      ]);
    } catch (e) {
      console.error('[Redis] connexion échouée au démarrage — arrêt du serveur:', e.message);
      process.exit(1);
    }
    io.adapter(createAdapter(pubClient, subClient));
    setDataClient(dataClient);
    console.log('[Redis] adapter Socket.IO actif —', REDIS_URL.replace(/:\/\/[^@]*@/, '://***@'));
  } else {
    console.log('[Redis] REDIS_URL absent — adapter en mémoire (mono-instance uniquement)');
  }

  server.listen(PORT, () => {
    console.log(`Serveur en marche sur le port ${PORT}`);
    resetStalePresence();
    registerBroadcastJobHandlers();
    registerWelcomeJobHandlers();
    // Les jobs de trajet tournent hors requête : ils n'ont pas accès à
    // req.app.get('io'), il faut donc le leur donner explicitement.
    setTripIo(io);
    registerTripJobHandlers();
    setCallStateIo(io);
    setCallStateUserSockets(userSockets);
    registerCallStateJobHandlers();
    setMeetingIo(io);
    registerMeetingJobHandlers();
    initBroadcastCache().catch((e) => console.error('[Broadcast] init cache:', e.message));
    startJobWorker();
    startMeetingScheduler();
    startVerificationScheduler();
    stopAccountLifecycleSchedulers = startAccountLifecycleSchedulers();

    // Balayage de rétention. Chaque purge passe par le registre
    // (src/services/purgeRegistry.js) : il consulte l'interrupteur réglé
    // depuis l'admin, applique les durées surchargées, et journalise chaque
    // exécution — succès comme échec. Sans ce journal, rien ne distinguait
    // « la purge tourne et n'a rien à faire » de « la purge ne tourne pas »,
    // ce qui a laissé le bug d'alias SQL des médias passer inaperçu.
    //
    // Les baux restent indispensables : ils garantissent qu'une seule
    // instance exécute une purge donnée, sans quoi deux serveurs
    // supprimeraient les mêmes lignes en concurrence.
    const balayageRetention = () => {
      const purges = [
        ['broadcast_nightly_purge', 'broadcast'],
        ['welcome_status_purge',    'welcome_status'],
        ['trip_nightly_purge',      'trip'],
        ['data_retention_purge',    'data_retention'],
        ['media_nightly_purge',     'media'],
        // Balayage des partitions de médias. Il a son propre bail parce qu'il
        // n'a rien à voir avec le précédent : celui-ci interroge `message`,
        // celui-là ne touche qu'au système de fichiers. Sa correction ne
        // dépend d'ailleurs pas du bail — deux instances qui réclament la même
        // partition sont départagées par `rename`, atomique — mais le bail
        // évite qu'elles fassent le même `readdir` au même instant.
        ['media_partition_drop',    'media_partitions'],
      ];
      for (const [bail, purge] of purges) {
        withLease(bail, () => runPurgeIfEnabled(purge)).catch(
          (e) => console.error(`[Purge] ${purge}:`, e.message),
        );
      }
    };

    // Premier tour PEU APRÈS le démarrage, pas à l'instant même.
    //
    // Sans amorce du tout, la première exécution n'avait lieu qu'à T+24 h : un
    // serveur déployé plus d'une fois par jour ne purgeait donc jamais rien.
    // Mais amorcer immédiatement rend tout démarrage de serveur destructeur —
    // y compris un `node server.js` lancé en local pour vérifier un boot, ce
    // dépôt n'ayant pas de base de développement séparée (le .env local vise
    // la production). Ce délai laisse le temps d'interrompre un lancement de
    // test, tout en restant très inférieur à la durée de vie d'un vrai
    // serveur, pour lequel le comportement est inchangé.
    const AMORCE_MS = 10 * 60 * 1000;
    const amorce = setTimeout(balayageRetention, AMORCE_MS);
    amorce.unref?.();
    setInterval(balayageRetention, 24 * 60 * 60 * 1000);
  });
}

start();

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