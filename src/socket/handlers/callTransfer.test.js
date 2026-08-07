// Tests protocole transfert (fake timers) — cas A–H du contrat leaveTimer.
// Invitation / acceptation ≠ timer. Seul call_conf_ready valide arme 10 s.
const assert = require('assert');
const { leaveCallSession, failInvite, confReady } = require('./calls');
const callState = require('../state/callState');
const callSessions = require('../state/callSessions');
const pendingCalls = require('../state/pendingCalls');
const callDeviceOwnership = require('../state/callDeviceOwnership');

const CHRIS = 1; // A — initiateur
const AWA = 2;   // B — restant
const NADIA = 3; // C — cible

function fakeIo() {
  const sent = [];
  return {
    sent,
    to(room) {
      return {
        emit(event, payload) {
          sent.push({ room, event, payload });
        },
      };
    },
    eventsFor(userId) {
      return sent.filter((e) => e.room === `user_${userId}`).map((e) => e.event);
    },
  };
}

function reset() {
  [CHRIS, AWA, NADIA].forEach((id) => {
    callState.clear(id);
    pendingCalls.clear(id);
  });
  callSessions._reset();
  callDeviceOwnership._reset();
}

function twoWay(callId = 50) {
  callState.setInCall(CHRIS, { peerId: AWA, callId });
  callState.setInCall(AWA, { peerId: CHRIS, callId });
}

function openTransfer(callId = 50) {
  return callSessions.openWithPending({
    originCallId: callId,
    participants: [CHRIS, AWA],
    inviteeId: NADIA,
    byUserId: CHRIS,
    mode: 'transfer',
  });
}

function claimOwners(sessionId) {
  callDeviceOwnership.setCalling(sessionId, CHRIS, {
    activeDeviceId: 'dev-A',
    activeSocketId: 'sa',
  });
  const eA = callDeviceOwnership.getEntry(sessionId, CHRIS);
  if (eA) eA.state = 'active';
  callDeviceOwnership.ring(sessionId, AWA);
  callDeviceOwnership.ring(sessionId, NADIA);
  assert.ok(callDeviceOwnership.tryClaim(sessionId, AWA, 'dev-B', 'sb').ok);
  assert.ok(callDeviceOwnership.tryClaim(sessionId, NADIA, 'dev-C', 'sc').ok);
}

function installFakeTimers() {
  const scheduled = [];
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  global.setTimeout = (fn, ms, ...args) => {
    if (
      ms === callSessions.TRANSFER_AUTO_LEAVE_MS ||
      ms === callSessions.TRANSFER_READY_TIMEOUT_MS
    ) {
      const handle = { fn, ms, cleared: false, args };
      scheduled.push(handle);
      return handle;
    }
    return realSetTimeout(fn, ms, ...args);
  };
  global.clearTimeout = (handle) => {
    if (handle && typeof handle === 'object' && 'cleared' in handle) {
      handle.cleared = true;
      return;
    }
    return realClearTimeout(handle);
  };
  return {
    scheduled,
    realSetTimeout,
    restore() {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
    },
    activeLeave() {
      return scheduled.filter(
        (h) => h.ms === callSessions.TRANSFER_AUTO_LEAVE_MS && !h.cleared,
      );
    },
    activeReady() {
      return scheduled.filter(
        (h) => h.ms === callSessions.TRANSFER_READY_TIMEOUT_MS && !h.cleared,
      );
    },
  };
}

async function waitUntil(pred, realSetTimeout, tries = 120) {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((r) => realSetTimeout(r, 25));
  }
}

function promoteJoined(sessionId) {
  callSessions.promotePending(sessionId);
  callState.setInCall(NADIA, { peerId: CHRIS, callId: sessionId });
}

function armMediaReadyTimer(sessionId) {
  callSessions.markTransferJoined(
    sessionId,
    setTimeout(() => {}, callSessions.TRANSFER_READY_TIMEOUT_MS),
  );
}

function fireConfReady(io, sessionId) {
  const handlers = {};
  confReady(io, {
    authenticated: true,
    alanyaID: AWA,
    deviceId: 'dev-B',
    on(event, fn) { handlers[event] = fn; },
  }, null);
  handlers.call_conf_ready({ sessionId, peerId: String(NADIA) });
  return handlers;
}

(async () => {
  // ── A. Transfer lancé, C ne répond pas ─────────────────────────────────────
  {
    reset();
    twoWay();
    const timers = installFakeTimers();
    try {
      const s = openTransfer();
      assert.strictEqual(s.transfer.state, 'pending');
      assert.deepStrictEqual(
        callSessions.getTransferTimerFlags(s.sessionId),
        { state: 'pending', hasLeaveTimer: false, hasReadyTimer: false },
      );
      assert.strictEqual(timers.activeLeave().length, 0, 'A: invitation ≠ leaveTimer');

      const early = callSessions.registerTransferReady({
        sessionId: s.sessionId,
        reporterId: AWA,
        peerId: NADIA,
        leaveTimerFactory: () => setTimeout(() => {}, callSessions.TRANSFER_AUTO_LEAVE_MS),
      });
      assert.strictEqual(early.ok, false);
      assert.strictEqual(early.reason, 'NOT_JOINED');
      assert.strictEqual(timers.activeLeave().length, 0);
      assert.strictEqual(callState.get(CHRIS), 'in_call');
      assert.strictEqual(callState.get(AWA), 'in_call');
    } finally {
      timers.restore();
    }
  }

  // ── B. C refuse ────────────────────────────────────────────────────────────
  {
    reset();
    twoWay();
    const timers = installFakeTimers();
    try {
      const s = openTransfer();
      callState.setRinging(NADIA, { callId: s.sessionId, peerId: CHRIS });
      failInvite(fakeIo(), s.sessionId, 'declined');
      assert.strictEqual(callSessions.get(s.sessionId), null);
      assert.strictEqual(timers.activeLeave().length, 0, 'B: refus ≠ leaveTimer');
      assert.strictEqual(callState.get(CHRIS), 'in_call');
      assert.strictEqual(callState.get(AWA), 'in_call');
    } finally {
      timers.restore();
    }
  }

  // ── C. join sans ready : pas de leave à 10 s ; media timeout retire C ───────
  {
    reset();
    twoWay();
    const timers = installFakeTimers();
    try {
      const s = openTransfer();
      promoteJoined(s.sessionId);
      armMediaReadyTimer(s.sessionId);

      assert.deepStrictEqual(
        callSessions.getTransferTimerFlags(s.sessionId),
        { state: 'joined', hasLeaveTimer: false, hasReadyTimer: true },
      );
      assert.strictEqual(timers.activeLeave().length, 0, 'C: join ≠ leaveTimer');
      assert.strictEqual(timers.activeReady().length, 1);

      // Toujours A↔B↔C après « 10 s » (aucun leaveTimer)
      assert.strictEqual(callState.get(CHRIS), 'in_call');
      assert.strictEqual(callState.get(AWA), 'in_call');
      assert.strictEqual(callState.get(NADIA), 'in_call');

      callSessions.cancelTransfer(s.sessionId, 'media_not_ready');
      await leaveCallSession(fakeIo(), null, NADIA, 'media_not_ready');
      assert.strictEqual(callState.get(CHRIS), 'in_call');
      assert.strictEqual(callState.get(AWA), 'in_call');
      assert.strictEqual(callState.get(NADIA), 'idle');
      assert.strictEqual(timers.activeLeave().length, 0);
    } finally {
      timers.restore();
    }
  }

  // ── D. ready → leaveTimer ; A sort à t+10 ; B↔C restent ────────────────────
  {
    reset();
    twoWay(78);
    const timers = installFakeTimers();
    try {
      const s = openTransfer(78);
      promoteJoined(s.sessionId);
      armMediaReadyTimer(s.sessionId);
      claimOwners(s.sessionId);
      const io = fakeIo();
      fireConfReady(io, s.sessionId);

      assert.ok(io.sent.some((e) => e.event === 'call_transfer_armed'));
      assert.strictEqual(callSessions.getTransferTimerFlags(s.sessionId).state, 'armed');
      assert.strictEqual(timers.activeLeave().length, 1, 'D: leaveTimer après ready');
      assert.strictEqual(timers.activeReady().length, 0, 'D: readyTimer annulé');
      assert.strictEqual(callState.get(CHRIS), 'in_call', 'D: A présent avant expiration');

      const leaveFn = timers.activeLeave()[0].fn;
      const realSetTimeout = timers.realSetTimeout;
      leaveFn();
      timers.restore();
      await waitUntil(
        () => io.eventsFor(CHRIS).includes('call_transfer_done'),
        realSetTimeout,
      );

      assert.strictEqual(callState.get(CHRIS), 'idle');
      assert.strictEqual(callState.get(AWA), 'in_call');
      assert.strictEqual(callState.get(NADIA), 'in_call');
      assert.ok(io.eventsFor(CHRIS).includes('call_transfer_done'));
      assert.ok(io.eventsFor(CHRIS).includes('call_ended'));
    } catch (e) {
      timers.restore();
      throw e;
    }
  }

  // ── E. A raccroche avant t+10 ──────────────────────────────────────────────
  {
    reset();
    twoWay();
    const timers = installFakeTimers();
    try {
      const s = openTransfer();
      promoteJoined(s.sessionId);
      armMediaReadyTimer(s.sessionId);
      callSessions.registerTransferReady({
        sessionId: s.sessionId,
        reporterId: AWA,
        peerId: NADIA,
        leaveTimerFactory: () => setTimeout(() => {
          throw new Error('E: second leave ne doit pas s\'exécuter');
        }, callSessions.TRANSFER_AUTO_LEAVE_MS),
      });
      assert.strictEqual(timers.activeLeave().length, 1);
      await leaveCallSession(fakeIo(), null, CHRIS, 'hangup');
      assert.strictEqual(timers.activeLeave().length, 0, 'E: leaveTimer annulé');
      assert.strictEqual(callState.get(AWA), 'in_call');
      assert.strictEqual(callState.get(NADIA), 'in_call');
    } finally {
      timers.restore();
    }
  }

  // ── F. C quitte pendant le délai ───────────────────────────────────────────
  {
    reset();
    twoWay();
    const timers = installFakeTimers();
    try {
      const s = openTransfer();
      promoteJoined(s.sessionId);
      armMediaReadyTimer(s.sessionId);
      callSessions.registerTransferReady({
        sessionId: s.sessionId,
        reporterId: AWA,
        peerId: NADIA,
        leaveTimerFactory: () => setTimeout(() => {
          throw new Error('F: leave auto ne doit pas partir');
        }, callSessions.TRANSFER_AUTO_LEAVE_MS),
      });
      await leaveCallSession(fakeIo(), null, NADIA, 'hangup');
      assert.strictEqual(timers.activeLeave().length, 0, 'F: leaveTimer annulé');
      assert.strictEqual(callState.get(CHRIS), 'in_call');
      assert.strictEqual(callState.get(AWA), 'in_call');
      assert.strictEqual(callSessions.getByUser(CHRIS).transfer.state, 'cancelled');
    } finally {
      timers.restore();
    }
  }

  // ── G. B quitte pendant le délai : A non retiré ────────────────────────────
  {
    reset();
    twoWay();
    const timers = installFakeTimers();
    try {
      const s = openTransfer();
      promoteJoined(s.sessionId);
      armMediaReadyTimer(s.sessionId);
      callSessions.registerTransferReady({
        sessionId: s.sessionId,
        reporterId: AWA,
        peerId: NADIA,
        leaveTimerFactory: () => setTimeout(() => {
          throw new Error('G: leave auto ne doit pas partir');
        }, callSessions.TRANSFER_AUTO_LEAVE_MS),
      });
      await leaveCallSession(fakeIo(), null, AWA, 'hangup');
      assert.strictEqual(timers.activeLeave().length, 0, 'G: leaveTimer annulé');
      assert.strictEqual(callState.get(CHRIS), 'in_call');
      assert.strictEqual(callState.get(NADIA), 'in_call');
      assert.ok(!callSessions.canCompleteTransfer(callSessions.getByUser(CHRIS)));
    } finally {
      timers.restore();
    }
  }

  // ── H. Double call_conf_ready : un seul timer ──────────────────────────────
  {
    reset();
    twoWay(88);
    const timers = installFakeTimers();
    try {
      const s = openTransfer(88);
      promoteJoined(s.sessionId);
      armMediaReadyTimer(s.sessionId);
      claimOwners(s.sessionId);
      const io = fakeIo();
      const handlers = fireConfReady(io, s.sessionId);
      handlers.call_conf_ready({ sessionId: s.sessionId, peerId: String(NADIA) });
      handlers.call_conf_ready({ sessionId: s.sessionId, peerId: String(NADIA) });

      assert.strictEqual(timers.activeLeave().length, 1, 'H: un seul leaveTimer');
      assert.strictEqual(
        io.sent.filter((e) => e.event === 'call_transfer_armed').length,
        1,
        'H: un seul call_transfer_armed',
      );

      const leaveFn = timers.activeLeave()[0].fn;
      const realSetTimeout = timers.realSetTimeout;
      leaveFn();
      timers.restore();
      await waitUntil(() => callState.get(CHRIS) === 'idle', realSetTimeout);
      assert.strictEqual(callState.get(CHRIS), 'idle');
      assert.strictEqual(callState.get(AWA), 'in_call');
      assert.strictEqual(callState.get(NADIA), 'in_call');
    } catch (e) {
      timers.restore();
      throw e;
    }
  }

  // ── Gardes reporter / peer ─────────────────────────────────────────────────
  {
    reset();
    twoWay();
    const s = openTransfer();
    promoteJoined(s.sessionId);
    assert.strictEqual(
      callSessions.registerTransferReady({
        sessionId: s.sessionId,
        reporterId: CHRIS,
        peerId: NADIA,
      }).reason,
      'INVALID_REPORTER',
    );
    assert.strictEqual(
      callSessions.registerTransferReady({
        sessionId: s.sessionId,
        reporterId: AWA,
        peerId: CHRIS,
      }).reason,
      'WRONG_PEER',
    );
    assert.strictEqual(
      callSessions.getTransferTimerFlags(s.sessionId).hasLeaveTimer,
      false,
    );
  }

  console.log('✅ callTransfer.test.js — cas A–H + gardes ready passent');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
