/**
 * Preuve d'atomicité de callDeviceOwnership.tryClaim contre un VRAI Redis —
 * pas les tests fonctionnels séquentiels de deviceIdOwnershipFoundation.test.js/
 * callMultiDeviceRace.test.js, qui passeraient tout aussi bien avec un portage
 * naïf GET+SET (deux appels séparés, sans script Lua) puisqu'ils n'exercent
 * jamais deux appels VRAIMENT concurrents.
 *
 * Deux connexions Redis distinctes (comme deux instances pm2 différentes)
 * envoient chacune un tryClaim au même instant via Promise.all — le script
 * Lua doit garantir qu'un seul gagne, à chaque itération, sur N répétitions
 * (Redis sérialise l'exécution d'un script, mais ce test vérifie que le CODE
 * utilise bien ce mécanisme, pas seulement qu'il "marche en général").
 *
 * Garde-fou négatif obligatoire (même esprit que --no-adapter du smoke-test
 * de la phase 1) : une implémentation naïve GET-puis-SET (deux commandes
 * séparées, sans Lua) DOIT échouer sous ce même harnais — sans cette preuve,
 * rien ne garantit que le test a le pouvoir de détecter le bug qu'il est
 * censé attraper.
 *
 * Nécessite REDIS_URL — échec explicite si absent (pas de skip silencieux,
 * voir package.json:test:concurrency).
 */
const assert = require('assert');
const { createClient } = require('redis');
const { normalizeDeviceId } = require('../../utils/deviceId');

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error(
    'callDeviceOwnership.race.test.js requiert REDIS_URL (test de concurrence contre un vrai Redis) — ' +
    'aucun skip silencieux : lancer un Redis local et réessayer avec REDIS_URL=redis://localhost:PORT.',
  );
  process.exit(1);
}

const TRY_CLAIM_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return cjson.encode({ok=false, reason='NO_SESSION'}) end
local entry = cjson.decode(raw)
if entry.state == 'active' and entry.activeDeviceId then
  if entry.activeDeviceId == ARGV[2] then
    entry.activeSocketId = ARGV[3]
    redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(entry))
    return cjson.encode({ok=true, alreadyOwner=true, entry=entry})
  end
  return cjson.encode({ok=false, reason='CALL_ANSWERED_ELSEWHERE', entry=entry})
end
if entry.state == 'left' then return cjson.encode({ok=false, reason='CALL_LEFT'}) end
entry.activeDeviceId = ARGV[2]
entry.activeSocketId = ARGV[3]
entry.claimedAt = tonumber(ARGV[4])
entry.state = 'active'
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(entry))
return cjson.encode({ok=true, alreadyOwner=false, entry=entry})
`;

async function atomicTryClaim(client, key, userId, deviceId, socketId) {
  const raw = await client.eval(TRY_CLAIM_SCRIPT, {
    keys: [key],
    arguments: [String(userId), normalizeDeviceId(deviceId), socketId, String(Date.now())],
  });
  return JSON.parse(raw);
}

// Implémentation DÉLIBÉRÉMENT naïve — reproduit ce qu'un portage mécanique
// GET+SET (sans script Lua) donnerait. Doit échouer sous ce harnais.
async function naiveTryClaim(client, key, userId, deviceId, socketId) {
  const field = String(userId);
  const raw = await client.hGet(key, field);
  if (!raw) return { ok: false, reason: 'NO_SESSION' };
  const entry = JSON.parse(raw);
  if (entry.state === 'active' && entry.activeDeviceId) {
    if (entry.activeDeviceId === normalizeDeviceId(deviceId)) {
      return { ok: true, alreadyOwner: true };
    }
    return { ok: false, reason: 'CALL_ANSWERED_ELSEWHERE' };
  }
  // Fenêtre de course : rien n'empêche une deuxième commande de lire le même
  // état "pas encore actif" avant que celle-ci n'écrive.
  await new Promise((r) => setTimeout(r, 5));
  entry.activeDeviceId = normalizeDeviceId(deviceId);
  entry.activeSocketId = socketId;
  entry.state = 'active';
  await client.hSet(key, field, JSON.stringify(entry));
  return { ok: true, alreadyOwner: false };
}

async function runRace(claimFn, clientA, clientB, iterations) {
  let doubleWins = 0;
  for (let i = 0; i < iterations; i++) {
    const key = `alanya:test:race:${Date.now()}:${i}`;
    const ring = { activeDeviceId: null, activeSocketId: null, claimedAt: null, state: 'ringing' };
    await clientA.hSet(key, '1', JSON.stringify(ring));

    const [ra, rb] = await Promise.all([
      claimFn(clientA, key, 1, 'dev-A', 'sock-A'),
      claimFn(clientB, key, 1, 'dev-B', 'sock-B'),
    ]);
    const winners = (ra.ok ? 1 : 0) + (rb.ok ? 1 : 0);
    if (winners > 1) doubleWins++;

    await clientA.del(key);
  }
  return doubleWins;
}

(async () => {
  const clientA = createClient({ url: REDIS_URL });
  const clientB = createClient({ url: REDIS_URL });
  clientA.on('error', (e) => console.error('[redis:A]', e.message));
  clientB.on('error', (e) => console.error('[redis:B]', e.message));
  await clientA.connect();
  await clientB.connect();

  try {
    const ITERATIONS = 100;

    const doubleWinsAtomic = await runRace(atomicTryClaim, clientA, clientB, ITERATIONS);
    assert.strictEqual(
      doubleWinsAtomic, 0,
      `script Lua : ${doubleWinsAtomic}/${ITERATIONS} courses avec double gagnant — devrait être 0`,
    );
    console.log(`✓ tryClaim (script Lua) : 0/${ITERATIONS} double gagnant — atomique confirmé`);

    const doubleWinsNaive = await runRace(naiveTryClaim, clientA, clientB, ITERATIONS);
    assert.ok(
      doubleWinsNaive > 0,
      'garde-fou négatif : une implémentation GET+SET naïve devrait produire au moins un double ' +
      'gagnant sur 100 courses — si ce n\'est pas le cas, ce harnais ne prouve rien',
    );
    console.log(`✓ garde-fou négatif : GET+SET naïf produit bien ${doubleWinsNaive}/${ITERATIONS} double(s) gagnant(s) — le harnais détecte le bug`);

    console.log('callDeviceOwnership.race.test.js OK');
  } finally {
    // Sans .quit(), le client resté connecté empêche ce script one-shot de
    // se terminer (même piège que maxIdle/mysql2 documenté pour src/config/db.js).
    await clientA.quit();
    await clientB.quit();
  }
  process.exit(0);
})().catch((e) => {
  console.error('ÉCHEC:', e);
  process.exit(1);
});
