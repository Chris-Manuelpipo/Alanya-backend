/**
 * Tests présence — « en ligne » ⇔ au moins une socket du compte au premier plan.
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

/** Faux `io` minimal : rooms + sockets, comme l'adapter socket.io. */
const makeIo = (sockets) => ({
  sockets: {
    sockets: new Map(sockets.map((s) => [s.id, s])),
    adapter: {
      rooms: sockets.reduce((rooms, s) => {
        for (const room of s.rooms) {
          if (!rooms.has(room)) rooms.set(room, new Set());
          rooms.get(room).add(s.id);
        }
        return rooms;
      }, new Map()),
    },
  },
});

const socket = (id, alanyaID, isForeground) => ({
  id,
  isForeground,
  rooms: [`user_${alanyaID}`],
});

// Aucune socket → hors ligne.
assert.strictEqual(hasForegroundSocket(makeIo([]), 7), false);

// Socket connectée mais en arrière-plan → hors ligne.
// C'est le cœur du correctif : garder la socket ouverte pour recevoir les
// messages ne vaut plus « en ligne ».
assert.strictEqual(hasForegroundSocket(makeIo([socket('a', 7, false)]), 7), false);

// Socket au premier plan → en ligne.
assert.strictEqual(hasForegroundSocket(makeIo([socket('a', 7, true)]), 7), true);

// Multi-appareil : téléphone en arrière-plan, tablette active → toujours en ligne.
assert.strictEqual(
  hasForegroundSocket(makeIo([socket('a', 7, false), socket('b', 7, true)]), 7),
  true,
);

// Multi-appareil, les deux en arrière-plan → hors ligne.
assert.strictEqual(
  hasForegroundSocket(makeIo([socket('a', 7, false), socket('b', 7, false)]), 7),
  false,
);

// Le premier plan d'un AUTRE compte ne déteint pas.
assert.strictEqual(
  hasForegroundSocket(makeIo([socket('a', 7, false), socket('b', 9, true)]), 7),
  false,
);

// `isForeground` absent (socket authentifiée n'ayant rien déclaré) → hors ligne.
assert.strictEqual(
  hasForegroundSocket(makeIo([{ id: 'a', rooms: ['user_7'] }]), 7),
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
// garderait messages et appels en temps réel jusqu'à l'expiration du token.
const appareilSocket = (id, alanyaID, appareilId) => {
  const s = { id, appareilId, rooms: [`user_${alanyaID}`], closed: false };
  s.disconnect = () => { s.closed = true; };
  return s;
};

// Deux sockets de l'appareil 1 (reconnexion), une de l'appareil 2.
const s1a = appareilSocket('1a', 7, 1);
const s1b = appareilSocket('1b', 7, 1);
const s2  = appareilSocket('2',  7, 2);
const ioRevoc = makeIo([s1a, s1b, s2]);
assert.strictEqual(disconnectAppareilSockets(ioRevoc, 7, 1), 2);
assert.strictEqual(s1a.closed, true);
assert.strictEqual(s1b.closed, true);
// L'appareil voisin du même compte reste connecté.
assert.strictEqual(s2.closed, false);

// Socket sans `appareilId` (token antérieur à la migration 026) : elle n'est
// rattachée à aucune ligne `appareils`, aucune révocation ne peut la viser.
const sLegacy = appareilSocket('legacy', 7, null);
assert.strictEqual(disconnectAppareilSockets(makeIo([sLegacy]), 7, 1), 0);
assert.strictEqual(sLegacy.closed, false);

// Entrées dégradées : jamais de jet, jamais de fermeture au hasard.
assert.strictEqual(disconnectAppareilSockets(null, 7, 1), 0);
assert.strictEqual(disconnectAppareilSockets(makeIo([s2]), 7, null), 0);
assert.strictEqual(disconnectAppareilSockets(makeIo([s2]), 99, 2), 0);

console.log('userSocketRegistry.test.js OK');
