/**
 * Faux `io` Socket.IO pour tester le code qui dépend de `io.to(room).emit()`
 * et `io.in(room).fetchSockets()`, sans serveur ni adapter réel.
 *
 * Après la bascule vers `fetchSockets()` (audit scalabilité, intégration
 * Redis phase 1 — src/utils/userSocketRegistry.js), un mock d'`io` doit
 * exposer `.in(room).fetchSockets()` en plus de `.to(room).emit()`, et les
 * sockets doivent porter leurs propriétés dans `.data.*` (seul ce que
 * l'adapter Redis sérialise vers un `RemoteSocket` distant) plutôt qu'à
 * plat — remplace les mini-mocks dupliqués dans plusieurs fichiers de test.
 */

function makeFakeIo(sockets = []) {
  const byId = new Map(sockets.map((s) => [s.id, s]));
  const roomIndex = new Map();
  for (const s of sockets) {
    for (const r of s.rooms || []) {
      if (!roomIndex.has(r)) roomIndex.set(r, new Set());
      roomIndex.get(r).add(s.id);
    }
  }

  const socketsInRoom = (room) =>
    [...(roomIndex.get(room) || [])].map((id) => byId.get(id)).filter(Boolean);

  return {
    to(room) {
      return {
        emit(event, payload) {
          for (const s of socketsInRoom(room)) s.emit(event, payload);
        },
      };
    },
    in(room) {
      return {
        fetchSockets: async () => socketsInRoom(room),
      };
    },
    // Conservé pour le code non encore migré vers fetchSockets() (ex. rooms
    // de réunion/appel de groupe, voir le plan d'implémentation §Hors périmètre).
    sockets: { sockets: byId, adapter: { rooms: roomIndex } },
  };
}

function fakeSocket(id, { userId, deviceId, appareilId, isForeground, extraRooms = [] } = {}) {
  const events = [];
  const rooms = [...(userId != null ? [`user_${Number(userId)}`] : []), ...extraRooms];
  return {
    id,
    data: { deviceId, appareilId, isForeground },
    rooms,
    events,
    emit(event, payload) {
      events.push({ event, payload });
    },
    disconnect() {
      this._disconnected = true;
    },
  };
}

module.exports = { makeFakeIo, fakeSocket };
