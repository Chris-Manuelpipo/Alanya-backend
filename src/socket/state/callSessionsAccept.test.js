// Garde anti-double-join : l'acceptation doit être *persistée*. Entrée D1.
//
// `confJoin` écrivait `session.pending.acceptedByDeviceId` sur l'objet rendu
// par `getByUser`. En mémoire ça tenait ; en mode Redis, `getByUser` rend un
// objet fraîchement désérialisé — l'écriture partait dans une copie jetable et
// la garde qui relit ce champ voyait toujours null. Défense en profondeur
// devenue inopérante, et invisible aux tests qui tournent sans REDIS_URL.
//
// Ce test vérifie le contrat par le seul chemin observable : écrire, puis
// relire par `getByUser` — exactement ce que fait le handler.
// Le défaut n'existe QUE côté Redis : en mémoire, `getByUser` rend l'objet
// vivant, et l'ancienne écriture directe fonctionnait. Ce test exige donc un
// Redis, comme les tests de concurrence — sans skip silencieux.
const assert = require('assert');
const { createClient } = require('redis');
const { setDataClient } = require('../../config/redisData');

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error(
    'callSessionsAccept.test.js requiert REDIS_URL : la garde D1 ne se perd '
    + "qu'en mode Redis, où getByUser rend une copie. Lancer un Redis local et "
    + 'réessayer avec REDIS_URL=redis://localhost:PORT.',
  );
  process.exit(1);
}

const callSessions = require('./callSessions');
const pool = require('../../config/db');

const A = 901;
const B = 902;
const C = 903;

async function ouvrir() {
  if (callSessions._reset) callSessions._reset();
  const session = await callSessions.openWithPending({
    originCallId: 5150,
    isVideo: false,
    participants: [A, B],
    inviteeId: C,
    byUserId: A,
  });
  assert.ok(session, 'session ouverte');
  return session.sessionId;
}

async function main() {
  const client = createClient({ url: REDIS_URL });
  client.on('error', (e) => console.error('[redis]', e.message));
  await client.connect();
  setDataClient(client);
  await client.flushDb();

  // ── L'acceptation survit à une relecture ─────────────────────────────────
  const sessionId = await ouvrir();

  assert.strictEqual(
    (await callSessions.getByUser(C)).pending.acceptedByDeviceId,
    null,
    'personne n\'a encore accepté',
  );

  assert.strictEqual(
    await callSessions.markPendingAccepted(sessionId, {
      deviceId: 'dev_c1',
      socketId: 'sock_c1',
    }),
    true,
    'premier appareil accepté',
  );

  const relu = await callSessions.getByUser(C);
  assert.strictEqual(
    relu.pending.acceptedByDeviceId,
    'dev_c1',
    'l\'acceptation doit être relisible — c\'est tout le défaut D1',
  );
  assert.strictEqual(relu.pending.acceptedSocketId, 'sock_c1');

  // ── Un second appareil est refusé ────────────────────────────────────────
  assert.strictEqual(
    await callSessions.markPendingAccepted(sessionId, { deviceId: 'dev_c2' }),
    false,
    'la garde refuse un autre appareil',
  );
  assert.strictEqual(
    (await callSessions.getByUser(C)).pending.acceptedByDeviceId,
    'dev_c1',
    'et n\'écrase pas le premier',
  );

  // ── Le même appareil peut rejouer sans se bloquer lui-même ───────────────
  assert.strictEqual(
    await callSessions.markPendingAccepted(sessionId, { deviceId: 'dev_c1' }),
    true,
    'un rejeu du même appareil — reconnexion socket — reste accepté',
  );

  // ── Sans invitation en attente, il n'y a rien à noter ────────────────────
  await callSessions.promotePending(sessionId);
  assert.strictEqual(
    await callSessions.markPendingAccepted(sessionId, { deviceId: 'dev_c1' }),
    false,
    'invitation déjà promue : plus de pending à marquer',
  );

  if (callSessions._reset) callSessions._reset();
  await client.flushDb();
  await client.quit();
  // promotePending désarme ses délais par la file de tâches, donc par MySQL :
  // sans cette libération, le processus ne rend pas la main (voir C6).
  await pool.end();
  console.log('callSessionsAccept.test.js OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
