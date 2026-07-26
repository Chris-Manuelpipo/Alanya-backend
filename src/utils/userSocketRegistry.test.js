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

console.log('userSocketRegistry.test.js OK');
