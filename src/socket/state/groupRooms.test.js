// Salons d'appel de groupe — capacité, propriété, disparition à vide.
//
// Ce store n'avait aucun test : il vivait en `Map` non exportée dans
// handlers/calls.js, donc inatteignable. L'extraction en module le rend
// vérifiable, ce qui vaut autant que la répartition elle-même.
//
// Ces tests exercent le repli mémoire (aucun REDIS_URL ici) ; le contrôle de
// capacité sous vraie concurrence est vérifié dans groupRooms.race.test.js.
const assert = require('assert');
const groupRooms = require('./groupRooms');
const { maxParticipants } = require('../../constants/participantLimits');

const A = 1; const B = 2; const C = 3;

(async () => {
  groupRooms._reset();

  // ── Création : l'organisateur est dedans, et il est propriétaire ───────────
  const salon = await groupRooms.create('r1', {
    isVideo: true, ownerID: A, ownerInfo: { userName: 'Chris', userPhoto: null },
  });
  assert.strictEqual(salon.isVideo, true);
  assert.strictEqual(salon.ownerID, A);
  assert.strictEqual(salon.participants.size, 1);
  assert.strictEqual(salon.participants.get(A).userName, 'Chris');

  const relu = await groupRooms.get('r1');
  assert.strictEqual(relu.ownerID, A, 'propriétaire conservé');
  assert.strictEqual(relu.isVideo, true, 'mode vidéo conservé');

  // ── Entrées ───────────────────────────────────────────────────────────────
  let e = await groupRooms.join('r1', B, { userName: 'Awa', userPhoto: null });
  assert.strictEqual(e.ok, true);
  assert.strictEqual(e.room.participants.size, 2);

  // Réentrer ne duplique pas et ne consomme pas de place.
  e = await groupRooms.join('r1', B, { userName: 'Awa', userPhoto: 'x' });
  assert.strictEqual(e.ok, true);
  assert.strictEqual(e.room.participants.size, 2, 'réentrée sans doublon');

  // ── Capacité : un salon vidéo est plein à 4 ────────────────────────────────
  const limiteVideo = maxParticipants(true);
  for (let i = 0; i < limiteVideo; i += 1) {
    e = await groupRooms.join('r1', 100 + i, null);
    if (!e.ok) break;
  }
  assert.strictEqual(e.ok, false, 'le salon finit par être complet');
  assert.strictEqual(e.code, 'GROUP_CALL_FULL');
  assert.strictEqual(e.isVideo, true, 'le mode est rapporté pour le message');
  assert.strictEqual(e.limite, limiteVideo);
  assert.strictEqual((await groupRooms.get('r1')).participants.size, limiteVideo,
    'la limite n\'est jamais dépassée');

  // Un membre déjà présent entre encore, même salon plein — sinon une
  // reconnexion le laisserait dehors de son propre appel.
  e = await groupRooms.join('r1', A, { userName: 'Chris', userPhoto: null });
  assert.strictEqual(e.ok, true, 'un membre présent réentre même à salon plein');

  // ── Un salon audio accepte davantage de monde ─────────────────────────────
  groupRooms._reset();
  await groupRooms.create('r2', { isVideo: false, ownerID: A, ownerInfo: null });
  const limiteAudio = maxParticipants(false);
  assert.ok(limiteAudio > limiteVideo, 'l\'audio est plus permissif que la vidéo');
  for (let i = 1; i < limiteAudio; i += 1) {
    assert.strictEqual((await groupRooms.join('r2', 200 + i, null)).ok, true);
  }
  assert.strictEqual((await groupRooms.join('r2', 999, null)).ok, false, 'plein à la limite audio');

  // ── Salon créé par une arrivée tardive : sans organisateur ────────────────
  groupRooms._reset();
  e = await groupRooms.join('r3', C, { userName: 'Nadia', userPhoto: null });
  assert.strictEqual(e.ok, true, 'le salon naît de la première arrivée');
  const orphelin = await groupRooms.get('r3');
  assert.strictEqual(orphelin.ownerID, null,
    'sans organisateur : n\'importe quel membre pourra y mettre fin');
  assert.strictEqual(orphelin.isVideo, false, 'audio par défaut');

  // ── Départs : le salon disparaît quand il se vide ─────────────────────────
  groupRooms._reset();
  await groupRooms.create('r4', { isVideo: false, ownerID: A, ownerInfo: null });
  await groupRooms.join('r4', B, null);
  let d = await groupRooms.leave('r4', B);
  assert.deepStrictEqual(d, { restants: 1, detruit: false, etaitOrganisateur: false },
    'B n\'était pas organisateur');
  assert.ok(await groupRooms.get('r4'), 'salon encore là');
  d = await groupRooms.leave('r4', A);
  assert.deepStrictEqual(d, { restants: 0, detruit: true, etaitOrganisateur: true },
    'A l\'était — et le salon disparaît avec lui');
  assert.strictEqual(await groupRooms.get('r4'), null,
    'salon vide supprimé — sinon un participant fantôme le rendrait « complet »');

  // Retirer quelqu'un d'absent ne casse rien.
  assert.deepStrictEqual(await groupRooms.leave('r4', A),
    { restants: 0, detruit: false, etaitOrganisateur: false });
  assert.deepStrictEqual(await groupRooms.leave(null, A),
    { restants: 0, detruit: false, etaitOrganisateur: false });

  // ── destroy ───────────────────────────────────────────────────────────────
  await groupRooms.create('r5', { isVideo: false, ownerID: A, ownerInfo: null });
  await groupRooms.destroy('r5');
  assert.strictEqual(await groupRooms.get('r5'), null);

  console.log('groupRooms.test.js OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
