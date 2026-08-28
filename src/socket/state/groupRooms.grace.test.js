// Grâce à la déconnexion d'un salon de groupe — repli mémoire.
//
// Jusqu'ici, la chute d'une socket retirait le participant et annonçait son
// départ dans la seconde. Une coupure réseau de deux secondes faisait donc voir
// aux autres « X a quitté » puis « X a rejoint », avec démontage et remontage
// complet du maillage. La grâce tient la place le temps qu'il revienne.
//
// Tenir la place, et pas seulement différer l'annonce : un salon vidé de son
// dernier participant disparaît, et le suivant le recrée en audio et sans
// organisateur — un appel vidéo à quatre redevenait un salon audio à six que
// plus personne ne pouvait terminer.
const assert = require('assert');
const groupRooms = require('./groupRooms');

const A = 8801; // organisateur
const B = 8802;
const C = 8803;

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ── 1) Armer retient la place sans retirer personne ──────────────────────
  groupRooms._reset();
  await groupRooms.create('g1', { isVideo: true, ownerID: A, ownerInfo: null });
  await groupRooms.join('g1', B, null);

  const jeton = await groupRooms.armGrace('g1', B, () => {}, 60_000);
  assert.ok(jeton, 'armer rend un jeton');
  assert.strictEqual(await groupRooms.getGrace('g1', B), jeton);

  const salle = await groupRooms.get('g1');
  assert.ok(
    salle.participants.has(B),
    'le gracié garde sa place — la libérer laisserait le salon se dissoudre',
  );

  assert.strictEqual(
    await groupRooms.armGrace('g1', C, () => {}, 60_000),
    null,
    'on n\'arme pas sur quelqu\'un qui n\'est pas dans le salon',
  );
  assert.strictEqual(
    await groupRooms.armGrace('inconnue', B, () => {}, 60_000),
    null,
    'ni sur un salon qui n\'existe pas',
  );

  // ── 2) Le jeton courant consomme et retire ───────────────────────────────
  const r2 = await groupRooms.expireGrace('g1', B, jeton);
  assert.strictEqual(r2.consomme, true);
  assert.ok(
    !(await groupRooms.get('g1')).participants.has(B),
    'la grâce échue retire enfin le participant',
  );

  // ── 3) Un retour désarme, et le jeton périmé ne mord plus ────────────────
  groupRooms._reset();
  await groupRooms.create('g2', { isVideo: false, ownerID: A, ownerInfo: null });
  await groupRooms.join('g2', B, null);
  const ancien = await groupRooms.armGrace('g2', B, () => {}, 60_000);

  const retour = await groupRooms.join('g2', B, { userName: 'B' });
  assert.strictEqual(retour.ok, true);
  assert.strictEqual(retour.reprise, true, 'le retour se sait retour, pas arrivée');
  assert.strictEqual(await groupRooms.getGrace('g2', B), null, 'la grâce est désarmée');

  const r3 = await groupRooms.expireGrace('g2', B, ancien);
  assert.strictEqual(r3.consomme, false, 'un jeton périmé ne consomme rien');
  assert.ok(
    (await groupRooms.get('g2')).participants.has(B),
    'et surtout : le revenant est toujours là. Vérifier le jeton puis retirer en '
    + 'deux gestes séparés laisserait un rejoin se glisser entre les deux',
  );

  // ── 4) Le dernier participant en grâce ne dissout pas le salon ───────────
  groupRooms._reset();
  await groupRooms.create('g3', { isVideo: true, ownerID: A, ownerInfo: null });
  const j4 = await groupRooms.armGrace('g3', A, () => {}, 60_000);
  const pendant = await groupRooms.get('g3');
  assert.ok(pendant, 'le salon survit à la grâce de son dernier membre');
  assert.strictEqual(pendant.isVideo, true, 'et garde son mode vidéo');
  assert.strictEqual(pendant.ownerID, A, 'et son organisateur');

  await groupRooms.expireGrace('g3', A, j4);
  assert.strictEqual(
    await groupRooms.get('g3'), null,
    'une fois la grâce échue, le salon vide disparaît comme avant',
  );

  // ── 5) L'organisateur parti rend le droit de terminer ────────────────────
  groupRooms._reset();
  await groupRooms.create('g4', { isVideo: false, ownerID: A, ownerInfo: null });
  await groupRooms.join('g4', B, null);
  const j5 = await groupRooms.armGrace('g4', A, () => {}, 60_000);
  const r5 = await groupRooms.expireGrace('g4', A, j5);
  assert.strictEqual(r5.etaitOrganisateur, true);

  const apres = await groupRooms.get('g4');
  assert.strictEqual(
    apres.ownerID, null,
    'le droit de terminer est rendu à la salle',
  );
  // Le prédicat de end_group_call, reproduit tel quel.
  const peutTerminer = (uid) =>
    (apres.ownerID != null && apres.ownerID === uid)
    || (apres.ownerID == null && apres.participants.has(uid));
  assert.strictEqual(
    peutTerminer(B), true,
    'sans quoi plus personne ne pouvait mettre fin à l\'appel',
  );

  // ── 6) Un salon plein laisse rentrer celui qui y était déjà ──────────────
  groupRooms._reset();
  await groupRooms.create('g5', { isVideo: true, ownerID: A, ownerInfo: null });
  const limite = 4; // maxVideoParticipants
  for (let i = 1; i < limite; i += 1) await groupRooms.join('g5', 9000 + i, null);
  const plein = await groupRooms.get('g5');
  assert.strictEqual(plein.participants.size, limite, 'salon plein');

  await groupRooms.armGrace('g5', 9001, () => {}, 60_000);
  const revenant = await groupRooms.join('g5', 9001, null);
  assert.strictEqual(
    revenant.ok, true,
    'sa place était tenue : se voir refuser son propre appel serait absurde',
  );
  const etranger = await groupRooms.join('g5', 9999, null);
  assert.strictEqual(
    etranger.ok, false,
    'mais la capacité tient toujours pour qui n\'y était pas',
  );
  assert.strictEqual(etranger.code, 'GROUP_CALL_FULL');

  // ── 7) Deux jetons armés dans la même milliseconde diffèrent ─────────────
  groupRooms._reset();
  await groupRooms.create('g6', { isVideo: false, ownerID: A, ownerInfo: null });
  await groupRooms.join('g6', B, null);
  await groupRooms.join('g6', C, null);
  const jetons = new Set();
  for (const uid of [B, C, B, C]) {
    jetons.add(await groupRooms.armGrace('g6', uid, () => {}, 60_000));
  }
  assert.strictEqual(
    jetons.size, 4,
    'un horodatage aurait collisionné, et la seconde grâce aurait consommé la première',
  );

  // ── 8) La minuterie du repli mémoire est bien armée, puis rendue ─────────
  groupRooms._reset();
  await groupRooms.create('g7', { isVideo: false, ownerID: A, ownerInfo: null });
  await groupRooms.join('g7', B, null);
  let echue = false;
  await groupRooms.armGrace('g7', B, () => { echue = true; }, 30);
  assert.strictEqual(groupRooms._pendingGraceCount(), 1, 'une grâce court');
  await attendre(80);
  assert.strictEqual(echue, true, 'le repli mémoire déclenche bien à l\'échéance');
  // Et il fait le travail complet, pas seulement l'annonce : n'appeler que la
  // cascade laissait le participant annoncé parti mais toujours au salon — le
  // fantôme que le retrait immédiat d'avant la grâce existait pour éviter.
  assert.ok(
    !(await groupRooms.get('g7'))?.participants?.has(B),
    'l\'échéance doit AUSSI retirer le participant, comme le fait le worker',
  );

  // Et si quelqu'un est revenu entre-temps, l'échéance ne fait rien du tout.
  groupRooms._reset();
  await groupRooms.create('g7c', { isVideo: false, ownerID: A, ownerInfo: null });
  await groupRooms.join('g7c', B, null);
  let annonce = false;
  await groupRooms.armGrace('g7c', B, () => { annonce = true; }, 30);
  await groupRooms.join('g7c', B, null); // il revient
  await attendre(80);
  assert.strictEqual(annonce, false, 'aucune annonce de départ pour un revenant');
  assert.ok(
    (await groupRooms.get('g7c')).participants.has(B),
    'et il reste bien dans le salon',
  );

  // Et une remise à zéro annule ce qui courait : compter les entrées ne prouve
  // rien (la table est vidée de toute façon), il faut vérifier que le rappel ne
  // se déclenche plus.
  groupRooms._reset();
  await groupRooms.create('g7b', { isVideo: false, ownerID: A, ownerInfo: null });
  await groupRooms.join('g7b', B, null);
  let fantome = false;
  await groupRooms.armGrace('g7b', B, () => { fantome = true; }, 30);
  assert.strictEqual(groupRooms._pendingGraceCount(), 1);
  groupRooms._reset();
  assert.strictEqual(groupRooms._pendingGraceCount(), 0);
  await attendre(80);
  assert.strictEqual(
    fantome, false,
    'une minuterie oubliée à la remise à zéro déclencherait une cascade sur un '
    + 'salon qui n\'existe plus',
  );

  // ── 9) cancelGrace désarme sans retirer ──────────────────────────────────
  groupRooms._reset();
  await groupRooms.create('g8', { isVideo: false, ownerID: A, ownerInfo: null });
  await groupRooms.join('g8', B, null);
  const j9 = await groupRooms.armGrace('g8', B, () => {}, 60_000);
  await groupRooms.cancelGrace('g8', B);
  assert.strictEqual(await groupRooms.getGrace('g8', B), null);
  assert.ok((await groupRooms.get('g8')).participants.has(B), 'il reste dans le salon');
  assert.strictEqual(
    (await groupRooms.expireGrace('g8', B, j9)).consomme, false,
    'et son ancien jeton est sans effet',
  );

  // ── 10) Un identifiant de salon aberrant est refusé ──────────────────────
  assert.strictEqual(groupRooms.isValidRoomId('group_42_1724800000000'), true);
  assert.strictEqual(groupRooms.isValidRoomId(''), false);
  assert.strictEqual(groupRooms.isValidRoomId('a'.repeat(65)), false, 'trop long');
  assert.strictEqual(groupRooms.isValidRoomId('salle avec espace'), false);
  assert.strictEqual(groupRooms.isValidRoomId('alanya:*'), false, 'pas de joker Redis');
  assert.strictEqual(groupRooms.isValidRoomId(null), false);

  groupRooms._reset();
  console.log('groupRooms.grace.test.js OK');
}

main().catch((e) => { console.error(e); process.exit(1); });
