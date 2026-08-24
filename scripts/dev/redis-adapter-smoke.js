/**
 * Smoke-test mécanique de l'adapter Socket.IO Redis — valide UNIQUEMENT le
 * triplet socket.io + @socket.io/redis-adapter + redis, sans dépendance
 * DB/Firebase/JWT. Reproduit exactement le wiring de server.js (io.adapter,
 * fetchSockets(), socket.data.*) à plus petite échelle : deux serveurs
 * Socket.IO locaux distincts, connectés au même Redis, pour prouver que le
 * fan-out et fetchSockets() traversent bien la frontière de process — ce
 * qu'aucun test mono-process ne peut vérifier.
 *
 * Prérequis : un Redis accessible (voir REDIS_URL ci-dessous). Usage :
 *   REDIS_URL=redis://localhost:16379 node scripts/dev/redis-adapter-smoke.js
 *
 * Sans argument spécial, teste avec l'adapter actif (le cas nominal). Avec
 * --no-adapter, reproduit le comportement mono-instance actuel SANS adapter,
 * pour confirmer que ce script sait bien détecter une régression (le test 1
 * doit alors échouer — garde-fou négatif).
 */

const http = require('http');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:16379';
const USE_ADAPTER = !process.argv.includes('--no-adapter');
const PORT_A = 5101;
const PORT_B = 5102;

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

async function makeServer(port) {
  const httpServer = http.createServer();
  const io = new Server(httpServer, { cors: { origin: '*' } });

  if (USE_ADAPTER) {
    const pubClient = createClient({ url: REDIS_URL });
    const subClient = pubClient.duplicate();
    pubClient.on('error', (e) => console.error(`[redis:${port}:pub]`, e.message));
    subClient.on('error', (e) => console.error(`[redis:${port}:sub]`, e.message));
    await pubClient.connect();
    await subClient.connect();
    io.adapter(createAdapter(pubClient, subClient));
  }

  io.on('connection', (socket) => {
    socket.on('join', ({ userId, deviceId }) => {
      socket.data.deviceId = deviceId;
      socket.join(`user_${userId}`);
    });
  });

  await new Promise((resolve) => httpServer.listen(port, resolve));
  return { io, httpServer };
}

function connectClient(port) {
  return new Promise((resolve, reject) => {
    const client = ioClient(`http://localhost:${port}`, { transports: ['websocket'] });
    client.on('connect', () => resolve(client));
    client.on('connect_error', reject);
  });
}

function waitForEvent(client, event, ms = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    client.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload ?? true);
    });
  });
}

async function main() {
  console.log(`\n=== Smoke-test adapter Redis (${USE_ADAPTER ? 'AVEC' : 'SANS'} adapter) — REDIS_URL=${REDIS_URL} ===\n`);

  const serverA = await makeServer(PORT_A);
  const serverB = await makeServer(PORT_B);

  const clientA = await connectClient(PORT_A); // instance A — appelant
  const clientB = await connectClient(PORT_B); // instance B — le user 999, deviceB

  clientA.emit('join', { userId: 999, deviceId: 'devA' });
  clientB.emit('join', { userId: 999, deviceId: 'devB' });
  await new Promise((r) => setTimeout(r, 300)); // laisser le temps aux join() de propager

  // Test 1 — émission cross-serveur.
  const received = waitForEvent(clientB, 'probe');
  serverA.io.to('user_999').emit('probe', { ok: true });
  const probeResult = await received;
  assert(
    USE_ADAPTER ? probeResult && probeResult.ok === true : probeResult === null,
    USE_ADAPTER
      ? "émission depuis A atteint le client connecté à B (probe reçu)"
      : "garde-fou négatif : sans adapter, B ne reçoit RIEN depuis A (confirme que le test sait détecter une régression)",
  );

  if (USE_ADAPTER) {
    // Test 2 — fetchSockets() cross-instance expose bien .data.*
    const sockets = await serverA.io.in('user_999').fetchSockets();
    assert(sockets.length === 2, `fetchSockets() depuis A voit 2 sockets (obtenu: ${sockets.length})`);
    const remoteB = sockets.find((s) => s.data?.deviceId === 'devB');
    assert(!!remoteB, "la socket distante (sur B) expose bien .data.deviceId === 'devB'");

    // Test 3 — disconnect cross-instance (mécanisme exact de disconnectAppareilSockets).
    if (remoteB) {
      const disconnected = waitForEvent(clientB, 'disconnect');
      remoteB.disconnect(true);
      const reason = await disconnected;
      assert(reason !== null, 'disconnect(true) sur la RemoteSocket ferme bien le client distant (sur B)');
    } else {
      failures++;
      console.error('  ✗ (test 3 sauté : remoteB introuvable)');
    }
  }

  clientA.close();
  clientB.close();
  await new Promise((resolve) => serverA.httpServer.close(resolve));
  await new Promise((resolve) => serverB.httpServer.close(resolve));
  if (serverA.io.of('/').adapter?.pubClient) {
    await serverA.io.of('/').adapter.pubClient.quit().catch(() => {});
    await serverA.io.of('/').adapter.subClient.quit().catch(() => {});
  }
  if (serverB.io.of('/').adapter?.pubClient) {
    await serverB.io.of('/').adapter.pubClient.quit().catch(() => {});
    await serverB.io.of('/').adapter.subClient.quit().catch(() => {});
  }

  console.log(`\n${failures === 0 ? 'OK' : 'ÉCHEC'} — ${failures} assertion(s) en échec.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Erreur fatale:', e);
  process.exit(1);
});
