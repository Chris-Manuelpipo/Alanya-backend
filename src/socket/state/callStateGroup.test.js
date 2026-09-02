// Un appel de groupe occupe, sans se faire passer pour un appel à deux.
//
// Les appels de groupe n'étaient inscrits nulle part : un utilisateur en pleine
// conversation de groupe était invisible à `isBusyForNewCall`, et `call_user`
// laissait passer un appel à deux vers lui — sonnerie plein écran par-dessus sa
// conversation. Le statut est distinct pour que les chemins 1-à-1, qui testent
// tous `ringing` ou `in_call` explicitement, ne le voient pas.
const assert = require('assert');
const callState = require('./callState');

const { statusOccupies, canRecordGroupCall } = callState;

const CHRIS = 1;
const AWA = 2;
const SALON = 'group_5_1712345678901';

(async () => {
  // ── Les décisions pures ────────────────────────────────────────────────
  assert.strictEqual(statusOccupies('in_group'), true, 'un groupe occupe');
  assert.strictEqual(statusOccupies('ringing'), true);
  assert.strictEqual(statusOccupies('in_call'), true);
  assert.strictEqual(statusOccupies(null), false);
  assert.strictEqual(statusOccupies('idle'), false);

  assert.strictEqual(canRecordGroupCall(null), true, 'état vierge : on inscrit');
  assert.strictEqual(canRecordGroupCall('in_group'), true, 'idempotent');
  assert.strictEqual(
    canRecordGroupCall('in_call'),
    false,
    'un appel à deux porte un pair et un identifiant dont tout dépend',
  );
  assert.strictEqual(canRecordGroupCall('ringing'), false);

  // ── L'inscription rend occupé pour un nouvel appel ─────────────────────
  await callState.clear(CHRIS);
  assert.strictEqual(
    await callState.isBusyForNewCall(CHRIS, AWA),
    false,
    'au repos, joignable',
  );

  assert.strictEqual(await callState.setInGroup(CHRIS, SALON), true);
  assert.strictEqual(
    await callState.isBusyForNewCall(CHRIS, AWA),
    true,
    'en groupe, plus joignable pour un appel à deux — c\'est tout l\'objet',
  );

  // ── Mais invisible aux chemins 1-à-1, qui testent le statut ────────────
  const entry = await callState.getEntry(CHRIS);
  assert.strictEqual(entry.status, 'in_group');
  assert.strictEqual(entry.peerId, null, 'un groupe n\'a pas de pair');
  assert.notStrictEqual(entry.status, 'in_call');
  assert.notStrictEqual(entry.status, 'ringing');

  // ── Un appel à deux en cours n'est jamais écrasé ───────────────────────
  await callState.clear(AWA);
  await callState.setInCall(AWA, { callId: '42', peerId: CHRIS });
  assert.strictEqual(
    await callState.setInGroup(AWA, SALON),
    false,
    'rejoindre un groupe pendant un appel n\'écrase pas l\'appel',
  );
  assert.strictEqual((await callState.getEntry(AWA)).status, 'in_call');

  // ── Le retrait ne touche que l'inscription de groupe ───────────────────
  assert.strictEqual(
    await callState.clearGroup(AWA),
    false,
    'un appel à deux ne se retire pas par le chemin du groupe',
  );
  assert.strictEqual((await callState.getEntry(AWA)).status, 'in_call');

  assert.strictEqual(await callState.clearGroup(CHRIS), true);
  assert.strictEqual(await callState.getEntry(CHRIS), null);

  console.log('callStateGroup.test.js OK');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
