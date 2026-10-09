/**
 * `node src/services/e2eePrekeyStock.test.js`
 *
 * Deux propriétés qui ne se voient pas à la relecture du code :
 *
 * 1. **`SKIP LOCKED` est bien dans la requête.** Sans lui, deux
 *    correspondants qui ouvrent une session avec le même appareil au même
 *    instant se bloquent, puis repartent avec la MÊME clé à usage unique —
 *    ce qui annule la propriété « à usage unique » et la protection du
 *    premier message. Le défaut est invisible en test manuel : il faut deux
 *    requêtes simultanées pour le provoquer.
 * 2. **Un stock vide rend `null`, pas une erreur.** L'amorçage retombe alors
 *    sur trois demi-échanges. Confondre les deux ferait refuser la
 *    conversation plutôt que de l'ouvrir en légèrement moins sûr.
 *
 * `reserveUneCle` reçoit sa connexion en paramètre : c'est ce qui rend ces
 * deux vérifications possibles sans MySQL.
 */

const assert = require('assert');
const {
  BUNDLES_PAR_LOT_MAX,
  CONSOMMATION_PAR_HEURE,
  filtreAutorises,
  quotasRestants,
  reserveUneCle,
  normaliseAppareilIds,
} = require('./e2eePrekeyStock');

/** Connexion factice : enregistre les requêtes, rend ce qu'on lui dit. */
function connFactice(reponses) {
  const vues = [];
  return {
    vues,
    async execute(sql, params) {
      vues.push({ sql, params });
      const r = reponses.shift();
      return [r === undefined ? [] : r, []];
    },
  };
}

(async () => {
  // ── La requête de réservation verrouille en sautant les lignes prises ───

  const conn = connFactice([
    [{ id: 10, key_id: 3, public_key: Buffer.alloc(33, 5) }],
    { affectedRows: 1 },
  ]);
  const cle = await reserveUneCle(conn, 42, 77);

  assert.ok(cle, 'une clé libre doit être rendue');
  assert.strictEqual(cle.key_id, 3);

  const select = conn.vues[0].sql;
  assert.match(
    select, /FOR UPDATE SKIP LOCKED/,
    'la réservation DOIT être en FOR UPDATE SKIP LOCKED : sans SKIP LOCKED, '
    + 'deux émetteurs simultanés repartent avec la même clé à usage unique',
  );
  assert.match(
    select, /claimed_at IS NULL/,
    'seules les clés encore libres peuvent être servies',
  );
  assert.match(
    select, /ORDER BY id/,
    'les plus anciennes d\'abord, pour que le stock tourne',
  );

  // La consommation est écrite, sur la ligne qu'on vient de lire, avec le
  // compte qui l'a consommée : c'est sur lui que porte le plafond par paire.
  assert.match(conn.vues[1].sql, /UPDATE e2ee_one_time_prekeys SET claimed_at = NOW\(\), claimed_by = \?/);
  assert.deepStrictEqual(conn.vues[1].params, [77, 10]);

  // ── Stock vide : `null`, et aucune écriture ─────────────────────────────

  const vide = connFactice([[]]);
  assert.strictEqual(
    await reserveUneCle(vide, 42), null,
    'un stock vide rend null — l\'amorçage se fera sur trois demi-échanges',
  );
  assert.strictEqual(
    vide.vues.length, 1,
    'stock vide : rien ne doit être écrit',
  );

  // ── Qui a le droit de lire : conversation partagée, et aucun blocage ────

  const lignes = [
    { id: 1, alanyaID: 10 }, // moi
    { id: 2, alanyaID: 20 }, // conversation partagée
    { id: 3, alanyaID: 30 }, // conversation partagée, mais blocage
    { id: 4, alanyaID: 40 }, // aucune conversation
  ];
  assert.deepStrictEqual(
    filtreAutorises(lignes, 10, new Set([20, 30]), new Set([30])).map((a) => a.appareilId),
    [1, 2],
    'mes appareils et ceux d\'un correspondant passent ; bloqué ou inconnu, non',
  );
  // Témoin : sans le blocage, le même appareil passe — le refus vient bien
  // du blocage et pas d'autre chose.
  assert.deepStrictEqual(
    filtreAutorises(lignes, 10, new Set([20, 30]), new Set()).map((a) => a.appareilId),
    [1, 2, 3],
  );
  // Mes propres appareils passent même si un blocage me vise par erreur.
  assert.deepStrictEqual(
    filtreAutorises([{ id: 1, alanyaID: 10 }], 10, new Set(), new Set([10])).map((a) => a.appareilId),
    [1],
  );

  // ── Plafond par paire ───────────────────────────────────────────────────

  const restants = quotasRestants(
    [{ alanyaID: 20, n: CONSOMMATION_PAR_HEURE }, { alanyaID: 30, n: 5 }],
    [20, 30, 40],
  );
  assert.strictEqual(restants.get(20), 0, 'plafond atteint : plus de clé à usage unique');
  assert.strictEqual(restants.get(30), CONSOMMATION_PAR_HEURE - 5);
  assert.strictEqual(restants.get(40), CONSOMMATION_PAR_HEURE, 'rien consommé : plafond entier');
  assert.strictEqual(
    quotasRestants([{ alanyaID: 20, n: 999 }], [20]).get(20), 0,
    'jamais négatif',
  );

  // ── Normalisation de la liste demandée ─────────────────────────────────

  assert.deepStrictEqual(
    normaliseAppareilIds([3, 1, 3, 2]), [3, 1, 2],
    'les doublons sont retirés, l\'ordre d\'arrivée conservé',
  );
  assert.deepStrictEqual(
    normaliseAppareilIds(['4', 5]), [4, 5],
    'les identifiants arrivent parfois en chaînes depuis JSON',
  );
  assert.deepStrictEqual(
    normaliseAppareilIds([7, 0, -2, 'x', null]), [7],
    'zéro, négatifs et non-nombres sont écartés sans faire échouer le lot',
  );

  const refuse = (entree, code, propos) => {
    try {
      normaliseAppareilIds(entree);
    } catch (e) {
      assert.strictEqual(e.code, code, `${propos} : code ${code} attendu, reçu ${e.code}`);
      return;
    }
    assert.fail(`${propos} : aurait dû être refusé`);
  };

  refuse('non', 'E2EE_APPAREILS_INVALIDE', 'liste qui n\'est pas une liste');
  refuse([], 'E2EE_APPAREILS_INVALIDE', 'liste vide');
  refuse([0, -1], 'E2EE_APPAREILS_INVALIDE', 'liste qui ne garde aucun identifiant');
  refuse(
    Array.from({ length: BUNDLES_PAR_LOT_MAX + 1 }, (_, i) => i + 1),
    'E2EE_APPAREILS_TROP',
    'lot au-delà du plafond',
  );

  // Pile au plafond : accepté. C'est la borne que le client doit respecter
  // en découpant ses demandes, il faut donc qu'elle soit atteignable.
  assert.strictEqual(
    normaliseAppareilIds(
      Array.from({ length: BUNDLES_PAR_LOT_MAX }, (_, i) => i + 1),
    ).length,
    BUNDLES_PAR_LOT_MAX,
  );

  console.log('e2eePrekeyStock.test.js OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
