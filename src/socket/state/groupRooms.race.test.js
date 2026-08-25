/**
 * Contrôle de capacité des salons de groupe, contre un VRAI Redis.
 *
 * C'est LE point où ce store était déjà incorrect avant toute répartition :
 * vérifier « reste-t-il une place ? » puis ajouter le participant sont deux
 * gestes. Si N personnes rejoignent au même instant alors qu'il reste une
 * place, chacune lit « oui » avant qu'aucune n'ait écrit, et le salon dépasse
 * sa limite — un appel vidéo à 6 quand le média n'en supporte que 4.
 *
 * Le test lance la limite + 3 arrivées simultanées et compte les acceptations.
 *
 * Nécessite REDIS_URL — échec explicite si absent (voir test:concurrency).
 */
const assert = require('assert');
const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error(
    'groupRooms.race.test.js requiert REDIS_URL (test de concurrence contre un vrai Redis) — '
    + 'aucun skip silencieux : lancer un Redis local et réessayer avec REDIS_URL=redis://localhost:PORT.',
  );
  process.exit(1);
}

const { setDataClient } = require('../../config/redisData');
const groupRooms = require('./groupRooms');
const { maxParticipants } = require('../../constants/participantLimits');

const ITERATIONS = 60;

(async () => {
  const client = createClient({ url: REDIS_URL });
  client.on('error', (e) => console.error('[redis]', e.message));
  await client.connect();
  setDataClient(client);

  try {
    // ── Ruée simultanée : la limite tient ────────────────────────────────────
    const limite = maxParticipants(true); // salon vidéo = la contrainte la plus stricte
    let debordements = 0;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const salon = `race_${i}`;
      await groupRooms.create(salon, { isVideo: true, ownerID: 1, ownerInfo: null });

      // Bien plus de candidats que de places, tous en même temps.
      const candidats = [];
      for (let u = 0; u < limite + 3; u += 1) candidats.push(groupRooms.join(salon, 100 + u, null));
      const issues = await Promise.all(candidats);

      const acceptes = issues.filter((r) => r.ok).length;
      const dedans = (await groupRooms.get(salon)).participants.size;
      if (dedans > limite) debordements += 1;
      assert.ok(acceptes >= 1, 'au moins une arrivée doit aboutir');
      await groupRooms.destroy(salon);
    }
    assert.strictEqual(
      debordements, 0,
      `capacité : ${debordements}/${ITERATIONS} salons au-delà de la limite`,
    );
    console.log(`✓ capacité : 0/${ITERATIONS} salon au-delà de ${limite} participants`);

    // ── Garde-fou négatif : la version naïve doit déborder ───────────────────
    const naif = async (salon, uid) => {
      const cle = `alanya:groupRooms:${salon}:p`;
      if (await client.hExists(cle, String(uid))) return true;
      if ((await client.hLen(cle)) >= limite) return false;
      await new Promise((r) => setTimeout(r, 3));
      await client.hSet(cle, String(uid), 'null');
      return true;
    };
    let debordementsNaifs = 0;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const salon = `naif_${i}`;
      const candidats = [];
      for (let u = 0; u < limite + 3; u += 1) candidats.push(naif(salon, 100 + u));
      await Promise.all(candidats);
      if ((await client.hLen(`alanya:groupRooms:${salon}:p`)) > limite) debordementsNaifs += 1;
      await client.del(`alanya:groupRooms:${salon}:p`);
    }
    assert.ok(
      debordementsNaifs > 0,
      'garde-fou négatif : un contrôle naïf devrait laisser déborder au moins un salon',
    );
    console.log(`✓ garde-fou négatif : la version naïve déborde ${debordementsNaifs}/${ITERATIONS} fois`);

    console.log('groupRooms.race.test.js OK');
  } finally {
    // Sans .quit(), le client resté connecté empêche ce script one-shot de finir.
    await client.quit();
  }
  process.exit(0);
})().catch((e) => {
  console.error('ÉCHEC:', e);
  process.exit(1);
});
