#!/usr/bin/env node
/**
 * Bench minimal Socket.IO message:send → message:sent.
 *
 * Usage:
 *   SOCKET_URL=https://www.alanya237.com TOKEN=... USERS=50 DURATION_SEC=30 \
 *     node scripts/load/socket-message-bench.js
 *
 * Prérequis : chaque TOKEN doit être un JWT valide (un seul user pour smoke,
 * ou une liste séparée par virgules dans TOKENS pour multi-user).
 *
 * Métriques : P50 / P95 latence ack, taux d'échec, throughput.
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

  // Attendre auth:verified si le serveur l'émet.
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 2000);
    socket.once('auth:verified', () => {
      clearTimeout(t);
      resolve();
    });
  });

  socket.on('message:sent', (payload) => {
    const clientId = payload?.clientId || payload?.clientID;
    const started = pending.get(clientId);
    if (started == null) return;
    pending.delete(clientId);
    latencies.push(Date.now() - started);
    acked++;
  });

  socket.on('message:send_failed', () => {
    failed++;
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

  return { sent, acked, failed, latencies, pending: pending.size };
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

  console.log(JSON.stringify({
    sent,
    acked,
    failed,
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
