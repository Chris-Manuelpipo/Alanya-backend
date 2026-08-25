// Tests protocole transfert (fake timers) — cas A–H du contrat leaveTimer.
// Invitation / acceptation ≠ timer. Seul call_conf_ready valide arme 10 s.
//
// Tous les stores d'appel sont async depuis la migration Redis (repli mémoire
// ici, aucun REDIS_URL dans ce test) : les délais restent donc de vrais
// setTimeout, que `installFakeTimers` peut intercepter par leur durée. Côté
// Redis ce sont des lignes job_queue, vérifiées ailleurs.
//
// Les délais s'arment désormais par (ms, callback) et non par un handle
// construit sur place : un handle setTimeout ne se sérialise pas.
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

async function reset() {
  for (const id of [CHRIS, AWA, NADIA]) {
    await callState.clear(id);
    await pendingCalls.clear(id);
  }
  callSessions._reset();
  callDeviceOwnership._reset();
}

async function twoWay(callId = 50) {
  await callState.setInCall(CHRIS, { peerId: AWA, callId });
  await callState.setInCall(AWA, { peerId: CHRIS, callId });
}

async function openTransfer(callId = 50) {
  return callSessions.openWithPending({
    originCallId: callId,
    participants: [CHRIS, AWA],
    inviteeId: NADIA,
    byUserId: CHRIS,
    mode: 'transfer',
  });
}

async function claimOwners(sessionId) {
  await callDeviceOwnership.setActive(sessionId, CHRIS, {
    activeDeviceId: 'dev-A',
    activeSocketId: 'sa',
  });
  await callDeviceOwnership.ring(sessionId, AWA);
  await callDeviceOwnership.ring(sessionId, NADIA);
  assert.ok((await callDeviceOwnership.tryClaim(sessionId, AWA, 'dev-B', 'sb')).ok);
  assert.ok((await callDeviceOwnership.tryClaim(sessionId, NADIA, 'dev-C', 'sc')).ok);
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

// 400 × 25 ms = 10 s. Ce qu'on attend n'est pas rapide : la cascade traverse
// de vrais allers-retours vers MySQL distant. L'ancien budget de 3 s suffisait
// à froid mais rendait le test instable dès que la base était sollicitée —
// il mesurait alors la latence du réseau, pas le comportement testé.
async function waitUntil(pred, realSetTimeout, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (await pred()) return;
    await new Promise((r) => realSetTimeout(r, 25));
  }
}

async function promoteJoined(sessionId) {
  await callSessions.promotePending(sessionId);
  await callState.setInCall(NADIA, { peerId: CHRIS, callId: sessionId });
}

async function armMediaReadyTimer(sessionId) {
  await callSessions.markTransferJoined(
    sessionId, callSessions.TRANSFER_READY_TIMEOUT_MS, () => {},
  );
}

// Retourne les handlers ET attend la résolution de call_conf_ready (async
// depuis la phase 2) avant de rendre la main à l'appelant.
async function fireConfReady(io, sessionId) {
  const handlers = {};
  confReady(io, {
    authenticated: true,
    alanyaID: AWA,
    deviceId: 'dev-B',
    on(event, fn) { handlers[event] = fn; },
  }, null);
  await handlers.call_conf_ready({ sessionId, peerId: String(NADIA) });
  return handlers;
}

(async () => {
  // ── A. Transfer lancé, C ne répond pas ─────────────────────────────────────
  {
    await reset();
    await twoWay();
    const timers = installFakeTimers();
    try {
      const s = await openTransfer();
      assert.strictEqual(s.transfer.state, 'pending');
      assert.deepStrictEqual(
        await callSessions.getTransferTimerFlags(s.sessionId),
        { state: 'pending', hasLeaveTimer: false, hasReadyTimer: false },
      );
      assert.strictEqual(timers.activeLeave().length, 0, 'A: invitation ≠ leaveTimer');

      const early = await callSessions.registerTransferReady({
        sessionId: s.sessionId,
        reporterId: AWA,
        peerId: NADIA,
        leaveTimerMs: callSessions.TRANSFER_AUTO_LEAVE_MS,
        onLeave: () => {},
      });
      assert.strictEqual(early.ok, false);
      assert.strictEqual(early.reason, 'NOT_JOINED');
      assert.strictEqual(timers.activeLeave().length, 0);
      assert.strictEqual(await callState.get(CHRIS), 'in_call');
      assert.strictEqual(await callState.get(AWA), 'in_call');
    } finally {
      timers.restore();
    }
  }

  // ── B. C refuse ────────────────────────────────────────────────────────────
  {
    await reset();
    await twoWay();
    const timers = installFakeTimers();
    try {
      const s = await openTransfer();
      await callState.setRinging(NADIA, { callId: s.sessionId, peerId: CHRIS });
      await failInvite(fakeIo(), s.sessionId, 'declined');
      assert.strictEqual(await callSessions.get(s.sessionId), null);
      assert.strictEqual(timers.activeLeave().length, 0, 'B: refus ≠ leaveTimer');
      assert.strictEqual(await callState.get(CHRIS), 'in_call');
      assert.strictEqual(await callState.get(AWA), 'in_call');
    } finally {
      timers.restore();
    }
  }

  // ── C. join sans ready : pas de leave à 10 s ; media timeout retire C ───────
  {
    await reset();
    await twoWay();
    const timers = installFakeTimers();
    try {
      const s = await openTransfer();
      await promoteJoined(s.sessionId);
      await armMediaReadyTimer(s.sessionId);

      assert.deepStrictEqual(
        await callSessions.getTransferTimerFlags(s.sessionId),
        { state: 'joined', hasLeaveTimer: false, hasReadyTimer: true },
      );
      assert.strictEqual(timers.activeLeave().length, 0, 'C: join ≠ leaveTimer');
      assert.strictEqual(timers.activeReady().length, 1);

      // Toujours A↔B↔C après « 10 s » (aucun leaveTimer)
      assert.strictEqual(await callState.get(CHRIS), 'in_call');
      assert.strictEqual(await callState.get(AWA), 'in_call');
      assert.strictEqual(await callState.get(NADIA), 'in_call');

      await callSessions.cancelTransfer(s.sessionId, 'media_not_ready');
      await leaveCallSession(fakeIo(), null, NADIA, 'media_not_ready');
      assert.strictEqual(await callState.get(CHRIS), 'in_call');
      assert.strictEqual(await callState.get(AWA), 'in_call');
      assert.strictEqual(await callState.get(NADIA), 'idle');
      assert.strictEqual(timers.activeLeave().length, 0);
    } finally {
      timers.restore();
    }
  }

  // ── D. ready → leaveTimer ; A sort à t+10 ; B↔C restent ────────────────────
  {
    await reset();
    await twoWay(78);
    const timers = installFakeTimers();
    try {
      const s = await openTransfer(78);
      await promoteJoined(s.sessionId);
      await armMediaReadyTimer(s.sessionId);
      await claimOwners(s.sessionId);
      const io = fakeIo();
      await fireConfReady(io, s.sessionId);

      assert.ok(io.sent.some((e) => e.event === 'call_transfer_armed'));
      assert.strictEqual((await callSessions.getTransferTimerFlags(s.sessionId)).state, 'armed');
      assert.strictEqual(timers.activeLeave().length, 1, 'D: leaveTimer après ready');
      assert.strictEqual(timers.activeReady().length, 0, 'D: readyTimer annulé');
      assert.strictEqual(await callState.get(CHRIS), 'in_call', 'D: A présent avant expiration');

      const leaveFn = timers.activeLeave()[0].fn;
      const realSetTimeout = timers.realSetTimeout;
      leaveFn();
      timers.restore();
      await waitUntil(
        () => io.eventsFor(CHRIS).includes('call_transfer_done'),
        realSetTimeout,
      );

      assert.strictEqual(await callState.get(CHRIS), 'idle');
      assert.strictEqual(await callState.get(AWA), 'in_call');
      assert.strictEqual(await callState.get(NADIA), 'in_call');
      assert.ok(io.eventsFor(CHRIS).includes('call_transfer_done'));
      // call_ended socket volontairement omis (transfer_done + FCM suffisent) ;
      // évite un raccrochage parasite côté restants.
      assert.ok(!io.eventsFor(AWA).includes('call_ended'));
      assert.ok(!io.eventsFor(NADIA).includes('call_ended'));
      assert.ok(io.eventsFor(AWA).includes('call_conf_left'));
      assert.ok(io.eventsFor(NADIA).includes('call_conf_left'));
    } catch (e) {
      timers.restore();
      throw e;
    }
  }

  // ── E. A raccroche avant t+10 ──────────────────────────────────────────────
  {
    await reset();
    await twoWay();
    const timers = installFakeTimers();
    try {
      const s = await openTransfer();
      await promoteJoined(s.sessionId);
      await armMediaReadyTimer(s.sessionId);
      await callSessions.registerTransferReady({
        sessionId: s.sessionId,
        reporterId: AWA,
        peerId: NADIA,
        leaveTimerMs: callSessions.TRANSFER_AUTO_LEAVE_MS,
        onLeave: () => { throw new Error('E: second leave ne doit pas s\'exécuter'); },
      });
      assert.strictEqual(timers.activeLeave().length, 1);
      await leaveCallSession(fakeIo(), null, CHRIS, 'hangup');
      assert.strictEqual(timers.activeLeave().length, 0, 'E: leaveTimer annulé');
      assert.strictEqual(await callState.get(AWA), 'in_call');
      assert.strictEqual(await callState.get(NADIA), 'in_call');
    } finally {
      timers.restore();
    }
  }

  // ── F. C quitte pendant le délai ───────────────────────────────────────────
  {
    await reset();
    await twoWay();
    const timers = installFakeTimers();
    try {
      const s = await openTransfer();
      await promoteJoined(s.sessionId);
      await armMediaReadyTimer(s.sessionId);
      await callSessions.registerTransferReady({
        sessionId: s.sessionId,
        reporterId: AWA,
        peerId: NADIA,
        leaveTimerMs: callSessions.TRANSFER_AUTO_LEAVE_MS,
        onLeave: () => { throw new Error('F: leave auto ne doit pas partir'); },
      });
      await leaveCallSession(fakeIo(), null, NADIA, 'hangup');
      assert.strictEqual(timers.activeLeave().length, 0, 'F: leaveTimer annulé');
      assert.strictEqual(await callState.get(CHRIS), 'in_call');
      assert.strictEqual(await callState.get(AWA), 'in_call');
      assert.strictEqual((await callSessions.getByUser(CHRIS)).transfer.state, 'cancelled');
    } finally {
      timers.restore();
    }
  }

  // ── G. B quitte pendant le délai : A non retiré ────────────────────────────
  {
    await reset();
    await twoWay();
    const timers = installFakeTimers();
    try {
      const s = await openTransfer();
      await promoteJoined(s.sessionId);
      await armMediaReadyTimer(s.sessionId);
      await callSessions.registerTransferReady({
        sessionId: s.sessionId,
        reporterId: AWA,
        peerId: NADIA,
        leaveTimerMs: callSessions.TRANSFER_AUTO_LEAVE_MS,
        onLeave: () => { throw new Error('G: leave auto ne doit pas partir'); },
      });
      await leaveCallSession(fakeIo(), null, AWA, 'hangup');
      assert.strictEqual(timers.activeLeave().length, 0, 'G: leaveTimer annulé');
      assert.strictEqual(await callState.get(CHRIS), 'in_call');
      assert.strictEqual(await callState.get(NADIA), 'in_call');
      assert.ok(!callSessions.canCompleteTransfer(await callSessions.getByUser(CHRIS)));
    } finally {
      timers.restore();
    }
  }

  // ── H. Double call_conf_ready : un seul timer ──────────────────────────────
  {
    await reset();
    await twoWay(88);
    const timers = installFakeTimers();
    try {
      const s = await openTransfer(88);
      await promoteJoined(s.sessionId);
      await armMediaReadyTimer(s.sessionId);
      await claimOwners(s.sessionId);
      const io = fakeIo();
      const handlers = await fireConfReady(io, s.sessionId);
      await handlers.call_conf_ready({ sessionId: s.sessionId, peerId: String(NADIA) });
      await handlers.call_conf_ready({ sessionId: s.sessionId, peerId: String(NADIA) });

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
      await waitUntil(async () => (await callState.get(CHRIS)) === 'idle', realSetTimeout);
      assert.strictEqual(await callState.get(CHRIS), 'idle');
      assert.strictEqual(await callState.get(AWA), 'in_call');
      assert.strictEqual(await callState.get(NADIA), 'in_call');
    } catch (e) {
      timers.restore();
      throw e;
    }
  }

  // ── Gardes reporter / peer ─────────────────────────────────────────────────
  {
    await reset();
    await twoWay();
    const s = await openTransfer();
    await promoteJoined(s.sessionId);
    assert.strictEqual(
      (await callSessions.registerTransferReady({
        sessionId: s.sessionId,
        reporterId: CHRIS,
        peerId: NADIA,
      })).reason,
      'INVALID_REPORTER',
    );
    assert.strictEqual(
      (await callSessions.registerTransferReady({
        sessionId: s.sessionId,
        reporterId: AWA,
        peerId: CHRIS,
      })).reason,
      'WRONG_PEER',
    );
    assert.strictEqual(
      (await callSessions.getTransferTimerFlags(s.sessionId)).hasLeaveTimer,
      false,
    );
  }

  console.log('✅ callTransfer.test.js — cas A–H + gardes ready passent');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
