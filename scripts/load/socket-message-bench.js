#!/usr/bin/env node
/**
 * Bench minimal Socket.IO message:send → message:sent.
 *
 * Usage:
 *   SOCKET_URL=https://www.alanya237.com TOKEN=... USERS=50 DURATION_SEC=30 \
 *     node scripts/load/socket-message-bench.js
 *
 * Prérequis : chaque TOKEN doit être un JWT d'accès valide (un seul user pour
 * smoke, ou une liste séparée par virgules dans TOKENS pour multi-user), et
 * `socket.io-client` doit être installé — c'est une devDependency, absente
 * d'un `npm install --production` : `npm install socket.io-client@4 --no-save`.
 *
 * Métriques : P50 / P95 latence ack, taux d'échec (avec le code de refus),
 * throughput.
 */

const { io } = require('socket.io-client');

const SOCKET_URL = process.env.SOCKET_URL || 'http://localhost:3000';
const TOKENS = (process.env.TOKENS || process.env.TOKEN || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
const USERS = Math.min(
  Number(process.env.USERS) || TOKENS.length || 1,
  Math.max(TOKENS.length, 1),
);
const DURATION_SEC = Number(process.env.DURATION_SEC) || 30;
const RATE_PER_USER = Number(process.env.RATE) || 1; // msg/s/user
const CONVERSATION_ID = Number(process.env.CONVERSATION_ID) || 0;
// Identifiant d'appareil de la socket : le même à chaque exécution, pour ne pas
// semer une session par mesure dans « Appareils connectés ».
const DEVICE_ID = process.env.DEVICE_ID || 'bench-perf-msg';

if (!TOKENS.length) {
  console.error('Set TOKEN or TOKENS (comma-separated JWTs)');
  process.exit(1);
}
if (!CONVERSATION_ID) {
  console.error('Set CONVERSATION_ID to a valid conversation');
  process.exit(1);
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function runUser(token, userIndex) {
  const latencies = [];
  let sent = 0;
  let acked = 0;
  let failed = 0;
  const pending = new Map();
  const failedCodes = new Map();

  const socket = io(SOCKET_URL, {
    transports: ['websocket'],
    auth: { token },
    extraHeaders: { Authorization: `Bearer ${token}` },
  });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`connect timeout user=${userIndex}`)), 15000);
    socket.on('connect', () => {
      clearTimeout(t);
      resolve();
    });
    socket.on('connect_error', (err) => {
      clearTimeout(t);
      reject(err);
    });
  });

  // Le serveur n'authentifie PAS depuis le handshake : il attend un événement
  // `auth:login` explicite (socket/handlers/auth.js), et tant qu'il ne l'a pas
  // reçu `socket.authenticated` reste faux — `message:send` répond alors
  // UNAUTHENTICATED. Sans cet emit, le bench mesurait 100 % d'échecs sans
  // aucune latence, ce qui ressemblait à une panne du serveur.
  await new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`auth timeout user=${userIndex} (pas d'auth:verified)`)),
      15000,
    );
    socket.once('auth:verified', () => {
      clearTimeout(t);
      resolve();
    });
    socket.once('auth:error', (e) => {
      clearTimeout(t);
      reject(new Error(`auth refusée user=${userIndex}: ${e?.code || ''} ${e?.message || ''}`));
    });
    socket.emit('auth:login', { token, deviceId: DEVICE_ID });
  });

  socket.on('message:sent', (payload) => {
    const clientId = payload?.clientId || payload?.clientID;
    const started = pending.get(clientId);
    if (started == null) return;
    pending.delete(clientId);
    latencies.push(Date.now() - started);
    acked++;
  });

  // Le code de refus est conservé : un compteur nu ne disait pas si l'envoi
  // était rejeté (blocage, droits) ou simplement non authentifié.
  socket.on('message:send_failed', (e) => {
    failed++;
    const code = e?.code || 'UNKNOWN';
    failedCodes.set(code, (failedCodes.get(code) || 0) + 1);
  });

  const endAt = Date.now() + DURATION_SEC * 1000;
  const intervalMs = Math.max(50, Math.floor(1000 / RATE_PER_USER));

  while (Date.now() < endAt) {
    const clientId = `bench_${userIndex}_${Date.now()}_${sent}`;
    pending.set(clientId, Date.now());
    socket.emit('message:send', {
      clientId,
      conversationID: CONVERSATION_ID,
      content: `bench ${userIndex} #${sent}`,
      type: 0,
      clickSentAt: new Date().toISOString(),
    });
    sent++;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  // Drain acks.
  await new Promise((r) => setTimeout(r, 3000));
  socket.close();

  return { sent, acked, failed, latencies, pending: pending.size, failedCodes };
}

(async () => {
  console.log(
    `[bench] url=${SOCKET_URL} users=${USERS} duration=${DURATION_SEC}s rate=${RATE_PER_USER}/s conv=${CONVERSATION_ID}`,
  );
  const tasks = [];
  for (let i = 0; i < USERS; i++) {
    const token = TOKENS[i % TOKENS.length];
    tasks.push(runUser(token, i));
  }
  const results = await Promise.all(tasks);
  const allLat = results.flatMap((r) => r.latencies).sort((a, b) => a - b);
  const sent = results.reduce((s, r) => s + r.sent, 0);
  const acked = results.reduce((s, r) => s + r.acked, 0);
  const failed = results.reduce((s, r) => s + r.failed, 0);
  const pending = results.reduce((s, r) => s + r.pending, 0);

  // Agrégation des motifs de refus : c'est la première chose à lire quand
  // `acked` est à zéro.
  const codes = {};
  for (const r of results) {
    for (const [code, n] of r.failedCodes) codes[code] = (codes[code] || 0) + n;
  }

  console.log(JSON.stringify({
    sent,
    acked,
    failed,
    ...(failed > 0 ? { failedCodes: codes } : {}),
    pendingNoAck: pending,
    p50_ms: percentile(allLat, 50),
    p95_ms: percentile(allLat, 95),
    p99_ms: percentile(allLat, 99),
    samples: allLat.length,
  }, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
