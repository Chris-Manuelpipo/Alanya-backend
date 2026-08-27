const assert = require('assert');
const pendingIce = require('./pendingIce');

// Repli mémoire (pas de REDIS_URL en test) : c'est le chemin exercé ici.
// Le chemin Redis partage l'API et est couvert par le smoke d'intégration.

(async () => {
  const CALL = '2039';
  const CALLEE = 42;

  // ── Un tampon vide se draine sans rien rendre ──────────────────────────────
  assert.deepStrictEqual(await pendingIce.drain(CALL, CALLEE), [],
    'tampon vide → liste vide');

  // ── Ce qui est gardé pendant la sonnerie ressort dans l'ordre ──────────────
  for (let i = 0; i < 3; i += 1) {
    const ok = await pendingIce.push(CALL, CALLEE, {
      candidate: { candidate: `candidate:${i}`, sdpMid: '0', sdpMLineIndex: 0 },
      generation: 0,
      callId: CALL,
    });
    assert.strictEqual(ok, true, `push ${i} accepté`);
  }

  const drained = await pendingIce.drain(CALL, CALLEE);
  assert.strictEqual(drained.length, 3, 'les trois candidats ressortent');
  assert.strictEqual(drained[0].candidate.candidate, 'candidate:0', 'ordre préservé');
  assert.strictEqual(drained[2].candidate.candidate, 'candidate:2', 'ordre préservé');
  assert.strictEqual(drained[1].callId, CALL, 'la charge utile est intacte');

  // ── Drainer vide le tampon : pas de rejeu en double ────────────────────────
  assert.deepStrictEqual(await pendingIce.drain(CALL, CALLEE), [],
    'second drain → rien (les candidats ne sont pas rejoués deux fois)');

  // ── Les tampons sont cloisonnés par appel et par utilisateur ───────────────
  await pendingIce.push(CALL, CALLEE, { candidate: { candidate: 'a' } });
  await pendingIce.push(CALL, 99, { candidate: { candidate: 'b' } });
  await pendingIce.push('2040', CALLEE, { candidate: { candidate: 'c' } });

  const forCallee = await pendingIce.drain(CALL, CALLEE);
  assert.strictEqual(forCallee.length, 1, 'un seul candidat pour ce couple');
  assert.strictEqual(forCallee[0].candidate.candidate, 'a', 'pas de fuite entre tampons');
  assert.strictEqual((await pendingIce.drain(CALL, 99)).length, 1, 'l\'autre destinataire garde le sien');
  assert.strictEqual((await pendingIce.drain('2040', CALLEE)).length, 1, 'l\'autre appel garde le sien');

  // ── clear() solde sans lire (appel refusé, annulé, sans réponse) ───────────
  await pendingIce.push(CALL, CALLEE, { candidate: { candidate: 'd' } });
  await pendingIce.clear(CALL, CALLEE);
  assert.deepStrictEqual(await pendingIce.drain(CALL, CALLEE), [],
    'clear vide le tampon');

  // ── Le plafond protège d'un client qui émettrait sans fin ──────────────────
  for (let i = 0; i < pendingIce.MAX_CANDIDATES; i += 1) {
    assert.strictEqual(
      await pendingIce.push(CALL, CALLEE, { candidate: { candidate: `x${i}` } }),
      true,
      `push ${i} sous le plafond`,
    );
  }
  assert.strictEqual(
    await pendingIce.push(CALL, CALLEE, { candidate: { candidate: 'overflow' } }),
    false,
    'au-delà du plafond, push refuse',
  );
  assert.strictEqual(
    (await pendingIce.drain(CALL, CALLEE)).length,
    pendingIce.MAX_CANDIDATES,
    'le tampon ne dépasse jamais son plafond',
  );

  // ── L'identifiant utilisateur est normalisé (string vs number) ─────────────
  await pendingIce.push(CALL, '77', { candidate: { candidate: 'e' } });
  assert.strictEqual(
    (await pendingIce.drain(CALL, 77)).length,
    1,
    'même tampon que la clé soit une chaîne ou un nombre',
  );

  console.log('pendingIce.test.js OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
