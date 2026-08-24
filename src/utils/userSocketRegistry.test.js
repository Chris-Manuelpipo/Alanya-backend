/**
 * Tests présence — « en ligne » ⇔ au moins une socket du compte au premier plan.
 *
 * Depuis l'intégration Redis (phase 1), `hasForegroundSocket`/
 * `disconnectAppareilSockets` passent par `io.in(room).fetchSockets()`
 * (async, cross-instance) et lisent `.data.*` plutôt que des propriétés à
 * plat — voir src/testUtils/fakeIo.js.
 */
const assert = require('assert');
const {
  createUserSocketRegistry,
  registerUserSocket,
  unregisterUserSocket,
  hasUserSockets,
  hasForegroundSocket,
  disconnectAppareilSockets,
} = require('./userSocketRegistry');
const { makeFakeIo, fakeSocket } = require('../testUtils/fakeIo');

(async () => {
  // Aucune socket → hors ligne.
  assert.strictEqual(await hasForegroundSocket(makeFakeIo([]), 7), false);

  // Socket connectée mais en arrière-plan → hors ligne.
  // C'est le cœur du correctif : garder la socket ouverte pour recevoir les
  // messages ne vaut plus « en ligne ».
  assert.strictEqual(
    await hasForegroundSocket(makeFakeIo([fakeSocket('a', { userId: 7, isForeground: false })]), 7),
    false,
  );

  // Socket au premier plan → en ligne.
  assert.strictEqual(
    await hasForegroundSocket(makeFakeIo([fakeSocket('a', { userId: 7, isForeground: true })]), 7),
    true,
  );

  // Multi-appareil : téléphone en arrière-plan, tablette active → toujours en ligne.
  assert.strictEqual(
    await hasForegroundSocket(
      makeFakeIo([
        fakeSocket('a', { userId: 7, isForeground: false }),
        fakeSocket('b', { userId: 7, isForeground: true }),
      ]),
      7,
    ),
    true,
  );

  // Multi-appareil, les deux en arrière-plan → hors ligne.
  assert.strictEqual(
    await hasForegroundSocket(
      makeFakeIo([
        fakeSocket('a', { userId: 7, isForeground: false }),
        fakeSocket('b', { userId: 7, isForeground: false }),
      ]),
      7,
    ),
    false,
  );

  // Le premier plan d'un AUTRE compte ne déteint pas.
  assert.strictEqual(
    await hasForegroundSocket(
      makeFakeIo([
        fakeSocket('a', { userId: 7, isForeground: false }),
        fakeSocket('b', { userId: 9, isForeground: true }),
      ]),
      7,
    ),
    false,
  );

  // `isForeground` absent (socket authentifiée n'ayant rien déclaré) → hors ligne.
  assert.strictEqual(
    await hasForegroundSocket(makeFakeIo([fakeSocket('a', { userId: 7 })]), 7),
    false,
  );

  // Non-régression du registre : passer en arrière-plan ne doit PAS désinscrire
  // la socket, sinon le routage des appels casserait. Le registre ne bouge donc
  // qu'aux connexions/déconnexions réelles.
  const registry = createUserSocketRegistry();
  registerUserSocket(registry, 7, 'a');
  registerUserSocket(registry, 7, 'b');
  assert.strictEqual(hasUserSockets(registry, 7), true);
  assert.strictEqual(unregisterUserSocket(registry, 7, 'a'), false);
  assert.strictEqual(hasUserSockets(registry, 7), true);
  assert.strictEqual(unregisterUserSocket(registry, 7, 'b'), true);
  assert.strictEqual(hasUserSockets(registry, 7), false);

  // ── Révocation d'un appareil : fermeture forcée de ses sockets ───────────
  // Le 401 du middleware ferme REST ; sans cette fermeture, l'appareil révoqué
  // garderait messages et appels en temps réel jusqu'à l'expiration du token
  // — y compris sur une AUTRE instance que celle ayant traité la révocation,
  // ce que fetchSockets() (cross-instance) corrige par rapport à l'ancienne
  // lecture locale de l'adapter.
  const appareilSocket = (id, alanyaID, appareilId) =>
    fakeSocket(id, { userId: alanyaID, appareilId });

  // Deux sockets de l'appareil 1 (reconnexion), une de l'appareil 2.
  const s1a = appareilSocket('1a', 7, 1);
  const s1b = appareilSocket('1b', 7, 1);
  const s2 = appareilSocket('2', 7, 2);
  const ioRevoc = makeFakeIo([s1a, s1b, s2]);
  assert.strictEqual(await disconnectAppareilSockets(ioRevoc, 7, 1), 2);
  assert.strictEqual(s1a._disconnected, true);
  assert.strictEqual(s1b._disconnected, true);
  // L'appareil voisin du même compte reste connecté.
  assert.strictEqual(s2._disconnected, undefined);

  // Socket sans `appareilId` (token antérieur à la migration 026) : elle n'est
  // rattachée à aucune ligne `appareils`, aucune révocation ne peut la viser.
  const sLegacy = appareilSocket('legacy', 7, null);
  assert.strictEqual(await disconnectAppareilSockets(makeFakeIo([sLegacy]), 7, 1), 0);
  assert.strictEqual(sLegacy._disconnected, undefined);

  // Entrées dégradées : jamais de jet, jamais de fermeture au hasard.
  assert.strictEqual(await disconnectAppareilSockets(null, 7, 1), 0);
  assert.strictEqual(await disconnectAppareilSockets(makeFakeIo([s2]), 7, null), 0);
  assert.strictEqual(await disconnectAppareilSockets(makeFakeIo([s2]), 99, 2), 0);

  console.log('userSocketRegistry.test.js OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
