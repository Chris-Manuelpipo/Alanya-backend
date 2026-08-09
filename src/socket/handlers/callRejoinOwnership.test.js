// call_rejoin / call_rejoin_answer : owner source obligatoire, jamais emitToUser.
const assert = require('assert');
const callState = require('../state/callState');
const callDeviceOwnership = require('../state/callDeviceOwnership');
const { callRejoin } = require('./calls');
const { deviceRoom } = require('../../utils/deviceId');

function reset() {
  [10, 77].forEach((id) => callState.clear(id));
  callDeviceOwnership.release('1329');
}

function setOwner(callId, userId, deviceId) {
  callDeviceOwnership.setCalling(callId, userId, {
    activeDeviceId: deviceId,
    activeSocketId: `s_${userId}`,
  });
  const e = callDeviceOwnership.getEntry(callId, userId);
  e.state = 'active';
}

function fakeSocket(userId, deviceId) {
  const handlers = {};
  const emitted = [];
  return {
    id: `sock_${userId}_${deviceId}`,
    alanyaID: userId,
    authenticated: true,
    deviceId,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
    on(event, handler) {
      handlers[event] = handler;
    },
    async trigger(event, data) {
      await handlers[event](data);
    },
    get emitted() {
      return emitted;
    },
  };
}

function fakeIo() {
  const roomEmits = [];
  const userEmits = [];
  return {
    sockets: { adapter: { rooms: new Map() } },
    to(room) {
      return {
        emit(event, payload) {
          if (String(room).startsWith('user_') && !String(room).includes('_device_')) {
            userEmits.push({ room, event, payload });
          } else {
            roomEmits.push({ room, event, payload });
          }
        },
      };
    },
    get roomEmits() {
      return roomEmits;
    },
    get userEmits() {
      return userEmits;
    },
  };
}

async function main() {
  const userSockets = new Map();

  // 1) Owner → emitToDevice call_rejoin_offer
  reset();
  callState.setInCall(10, { callId: '1329', peerId: 77 });
  callState.setInCall(77, { callId: '1329', peerId: 10 });
  setOwner('1329', 10, 'dev_10');
  setOwner('1329', 77, 'dev_77');
  const io = fakeIo();
  const sock = fakeSocket(10, 'dev_10');
  callRejoin(io, sock, userSockets);
  await sock.trigger('call_rejoin', {
    targetUserId: '77',
    offer: { sdp: 'v=0', type: 'offer' },
    generation: 2,
  });
  const offerEmit = io.roomEmits.find((e) => e.event === 'call_rejoin_offer');
  assert.ok(offerEmit, 'call_rejoin_offer émis');
  assert.strictEqual(offerEmit.room, deviceRoom(77, 'dev_77'));
  assert.strictEqual(offerEmit.payload.generation, 2);
  assert.strictEqual(io.userEmits.length, 0, 'pas de fan-out user_*');

  // 2) Non-owner source → ignore
  reset();
  callState.setInCall(10, { callId: '1329', peerId: 77 });
  callState.setInCall(77, { callId: '1329', peerId: 10 });
  setOwner('1329', 10, 'dev_10');
  setOwner('1329', 77, 'dev_77');
  const io2 = fakeIo();
  const sockSecondary = fakeSocket(10, 'dev_other');
  callRejoin(io2, sockSecondary, userSockets);
  await sockSecondary.trigger('call_rejoin', {
    targetUserId: '77',
    offer: { sdp: 'v=0', type: 'offer' },
  });
  assert.strictEqual(io2.roomEmits.length, 0, 'non-owner ne relaie pas');
  assert.strictEqual(io2.userEmits.length, 0);

  // 3) Owner cible absent → drop, pas emitToUser
  reset();
  callState.setInCall(10, { callId: '1329', peerId: 77 });
  callState.setInCall(77, { callId: '1329', peerId: 10 });
  setOwner('1329', 10, 'dev_10');
  // pas d'owner pour 77
  const io3 = fakeIo();
  const sock3 = fakeSocket(10, 'dev_10');
  callRejoin(io3, sock3, userSockets);
  await sock3.trigger('call_rejoin', {
    targetUserId: '77',
    offer: { sdp: 'v=0', type: 'offer' },
  });
  assert.strictEqual(io3.roomEmits.length, 0, 'drop si cible sans owner');
  assert.strictEqual(io3.userEmits.length, 0, 'jamais emitToUser fallback');

  // 4) call_rejoin_answer owner → device cible
  reset();
  callState.setInCall(77, { callId: '1329', peerId: 10 });
  callState.setInCall(10, { callId: '1329', peerId: 77 });
  setOwner('1329', 77, 'dev_77');
  setOwner('1329', 10, 'dev_10');
  const io4 = fakeIo();
  const sockAns = fakeSocket(77, 'dev_77');
  callRejoin(io4, sockAns, userSockets);
  await sockAns.trigger('call_rejoin_answer', {
    targetUserId: '10',
    answer: { sdp: 'v=0', type: 'answer' },
    generation: 2,
  });
  const ansEmit = io4.roomEmits.find((e) => e.event === 'call_rejoin_answer');
  assert.ok(ansEmit);
  assert.strictEqual(ansEmit.room, deviceRoom(10, 'dev_10'));
  assert.strictEqual(io4.userEmits.length, 0);

  reset();
  console.log('callRejoinOwnership.test.js OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
