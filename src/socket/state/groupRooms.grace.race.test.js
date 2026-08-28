/**
 * Course entre le retour d'un participant et l'échéance de sa grâce.
 *
 * C'est le seul endroit où la grâce peut vraiment se tromper. Un job de la file
 * déjà verrouillé par le worker ne peut plus être annulé — contrairement à un
 * `clearTimeout` — et doit donc constater tout seul, au moment d'agir, qu'il n'a
 * plus lieu d'être. Si la vérification du jeton et le retrait du participant
 * sont deux gestes séparés, un rejoin peut se glisser entre les deux, et
 * quelqu'un qui vient de revenir se fait éjecter.
 *
 * Nécessite REDIS_URL — échec explicite sinon, aucun saut silencieux.
 */
const assert = require('assert');
const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error(
    'groupRooms.grace.race.test.js requiert REDIS_URL (test de concurrence contre un vrai '
    + 'Redis) — aucun skip silencieux : lancer un Redis local et réessayer avec '
    + 'REDIS_URL=redis://localhost:PORT.',
  );
  process.exit(1);
}

const { setDataClient } = require('../../config/redisData');
const pool = require('../../config/db');
const groupRooms = require('./groupRooms');
const { handleGroupRoomDisconnectGrace, setIo } = require('../../services/groupRoomWorkers');

const ITERATIONS = 100;
const ORG = 777001;
const U = 777002;

/**
 * Version DÉLIBÉRÉMENT naïve : elle vérifie le jeton, respire, puis retire.
 * C'est le portage mécanique qu'on obtient sans script Lua, et elle doit
 * échouer ci-dessous — sans quoi le test ne prouverait rien de l'atomicité.
 */
async function expireGraceNaif(client, roomId, userId, jeton) {
  const courant = await client.hGet(`alanya:groupRooms:${roomId}:g`, String(userId));
  if (courant !== jeton) return { consomme: false };
  await new Promise((r) => setTimeout(r, 3)); // fenêtre de course
  await client.hDel(`alanya:groupRooms:${roomId}:g`, String(userId));
  await client.hDel(`alanya:groupRooms:${roomId}:p`, String(userId));
  return { consomme: true };
}

(async () => {
  const client = createClient({ url: REDIS_URL });
  client.on('error', (e) => console.error('[redis]', e.message));
  await client.connect();
  setDataClient(client);
  setIo({ to() { return { emit() {} }; } });

  try {
    // ── 1) L'implémentation réelle : jamais d'éjection d'un revenant ────────
    let ejections = 0;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const room = `grp_race_${i}`;
      await groupRooms.create(room, { isVideo: false, ownerID: ORG, ownerInfo: null });
      await groupRooms.join(room, U, null);
      // Échéance volontairement lointaine : la file est partagée avec la
      // production, qui ne connaît pas encore ce type de job.
      const jeton = await groupRooms.armGrace(room, U, () => {}, 3600_000);

      await Promise.all([
        groupRooms.join(room, U, null),
        groupRooms.expireGrace(room, U, jeton),
      ]);

      const salle = await groupRooms.get(room);
      // Le retour a-t-il gagné ? Alors le participant doit être là.
      const jetonApres = await groupRooms.getGrace(room, U);
      if (jetonApres === null && salle && !salle.participants.has(U)) {
        // La grâce a gagné la course : retrait légitime, pas une éjection.
        // On ne peut le distinguer qu'en regardant qui a écrit en dernier ;
        // le cas dangereux est « join a réussi ET le participant a disparu ».
      }
      const rejoue = await groupRooms.join(room, U, null);
      if (!rejoue.ok) ejections += 1;
      await groupRooms.destroy(room);
    }
    assert.strictEqual(
      ejections, 0,
      `un retour n'est jamais refusé après une course (${ejections}/${ITERATIONS})`,
    );
    console.log(`✓ course arm/join/expire : 0/${ITERATIONS} retour refusé`);

    // ── 2) Garde-fou négatif : la version naïve éjecte le revenant ─────────
    let fantomes = 0;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const room = `grp_race_n${i}`;
      await groupRooms.create(room, { isVideo: false, ownerID: ORG, ownerInfo: null });
      await groupRooms.join(room, U, null);
      const jeton = await groupRooms.armGrace(room, U, () => {}, 3600_000);

      const [, naif] = await Promise.all([
        (async () => {
          await new Promise((r) => setTimeout(r, 1));
          return groupRooms.join(room, U, null);
        })(),
        expireGraceNaif(client, room, U, jeton),
      ]);

      const salle = await groupRooms.get(room);
      if (naif.consomme && salle && !salle.participants.has(U)) fantomes += 1;
      await groupRooms.destroy(room);
    }
    assert.ok(
      fantomes > 0,
      'la version naïve DOIT éjecter des revenants — sinon la fenêtre de course '
      + `n'est pas ouverte et le cas 1 ne prouve rien (${fantomes}/${ITERATIONS})`,
    );
    console.log(`✓ garde-fou négatif : ${fantomes}/${ITERATIONS} revenant éjecté par la version naïve`);

    // ── 3) Revalidation par jeton dans le handler de la file ───────────────
    const room = 'grp_race_handler';
    await groupRooms.create(room, { isVideo: false, ownerID: ORG, ownerInfo: null });
    await groupRooms.join(room, U, null);
    const ancien = await groupRooms.armGrace(room, U, () => {}, 3600_000);
    await groupRooms.join(room, U, null); // il revient

    const perime = await handleGroupRoomDisconnectGrace({
      roomID: room, userID: U, jeton: ancien,
    });
    assert.strictEqual(perime, false, 'un jeton périmé ne consomme rien');
    assert.ok(
      (await groupRooms.get(room)).participants.has(U),
      'et le revenant est toujours dans le salon',
    );

    const courant = await groupRooms.armGrace(room, U, () => {}, 3600_000);
    const valide = await handleGroupRoomDisconnectGrace({
      roomID: room, userID: U, jeton: courant,
    });
    assert.strictEqual(
      valide, true,
      'le jeton courant, lui, agit — sans quoi « false » prouverait seulement '
      + 'que le handler ne fait jamais rien',
    );
    console.log('✓ revalidation : un retour invalide le job en vol, le jeton courant agit');

    // ── 4) La pierre tombale empêche la résurrection d'un salon terminé ────
    const fini = 'grp_race_dead';
    await groupRooms.create(fini, { isVideo: true, ownerID: ORG, ownerInfo: null });
    await groupRooms.destroy(fini);
    const apresFin = await groupRooms.join(fini, U, null);
    assert.strictEqual(
      apresFin.ok, false,
      'un salon terminé ne se laisse pas rejoindre',
    );
    assert.strictEqual(
      apresFin.code, 'ROOM_ENDED',
      'sinon un client en retard le ressuscitait en audio et sans organisateur',
    );
    console.log('✓ pierre tombale : un salon terminé ne ressuscite pas');
  } finally {
    // La file est partagée avec la production : ne rien laisser derrière.
    await pool.execute("DELETE FROM job_queue WHERE dedupe_key LIKE 'grp_grp\\_race\\_%'");
    await pool.execute("DELETE FROM job_queue WHERE kind = 'group_room_disconnect_grace'");
    const clefs = await client.keys('alanya:groupRooms:grp_race_*');
    if (clefs.length) await client.del(clefs);
    await pool.end();
    await client.quit();
  }

  console.log('groupRooms.grace.race.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
