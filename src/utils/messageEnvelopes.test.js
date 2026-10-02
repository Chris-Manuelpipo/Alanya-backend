/**
 * `node src/utils/messageEnvelopes.test.js`
 *
 * Pourquoi ces vérifications, et pas d'autres : un message chiffré dont les
 * enveloppes sont mal formées est PERDU SANS RECOURS. L'émetteur reçoit son
 * accusé et affiche son ✓, le clair n'existe plus que sur son téléphone, et
 * aucun destinataire ne verra jamais rien. Il n'y a pas de rattrapage
 * possible côté serveur — il n'a aucune clé.
 *
 * Tout ce fichier garde donc une seule propriété : un envoi mal formé est
 * refusé AVANT l'INSERT, avec un code qui nomme le défaut.
 */

const assert = require('assert');
const {
  NONCE_OCTETS,
  ENV_AMORCAGE,
  ENV_CLIQUET,
  ENV_CHAINE_GROUPE,
  ENVELOPPES_MAX,
  CORPS_MAX_OCTETS,
  EnveloppeInvalide,
  normaliseChiffre,
  chiffrePourClient,
  ecritChiffre,
  chargeChiffrePourAppareil,
  marqueRemises,
} = require('./messageEnvelopes');

const b64 = (n, r = 7) => Buffer.alloc(n, r).toString('base64');
const MON_APPAREIL = 10;

const envoiValide = () => ({
  body: { ct: b64(64), nonce: b64(NONCE_OCTETS) },
  envelopes: [
    { appareilId: 20, header: '{"n":0}', envType: ENV_CLIQUET, wrappedKey: b64(48) },
    { appareilId: 11, header: '{"n":0}', envType: ENV_AMORCAGE, wrappedKey: b64(48) },
  ],
});

function refuse(entree, code, propos, emetteur = MON_APPAREIL) {
  try {
    normaliseChiffre(entree, emetteur);
  } catch (e) {
    assert.ok(e instanceof EnveloppeInvalide, `${propos} : EnveloppeInvalide attendue, reçu ${e}`);
    assert.strictEqual(e.code, code, `${propos} : code ${code} attendu, reçu ${e.code}`);
    return;
  }
  assert.fail(`${propos} : aurait dû être refusé`);
}

// ── Message en clair : rien de chiffré, et ce n'est pas une erreur ────────

assert.strictEqual(
  normaliseChiffre({ content: 'salut' }, MON_APPAREIL), null,
  'un message en clair ne porte ni corps ni enveloppes : null, pas une erreur',
);
assert.strictEqual(normaliseChiffre({}, MON_APPAREIL), null);

// ── Le cas nominal ───────────────────────────────────────────────────────

const c = normaliseChiffre(envoiValide(), MON_APPAREIL);
assert.strictEqual(c.body.length, 64);
assert.strictEqual(c.nonce.length, NONCE_OCTETS);
assert.strictEqual(c.enveloppes.length, 2);
assert.ok(Buffer.isBuffer(c.enveloppes[0].wrappedKey));

// ── Le corps ─────────────────────────────────────────────────────────────

refuse(
  { envelopes: envoiValide().envelopes },
  'E2EE_CORPS_MANQUANT', 'enveloppes sans corps',
);
refuse(
  { body: { ct: '', nonce: b64(NONCE_OCTETS) }, envelopes: envoiValide().envelopes },
  'E2EE_CORPS_MANQUANT', 'corps vide',
);
refuse(
  {
    body: { ct: b64(CORPS_MAX_OCTETS + 1), nonce: b64(NONCE_OCTETS) },
    envelopes: envoiValide().envelopes,
  },
  'E2EE_CORPS_TROP_GROS', 'corps au-delà du plafond',
);

// Le nonce : 12 octets, pas 11, pas 16. Un nonce de mauvaise taille fait
// échouer le déchiffrement chez TOUS les destinataires, et l'échec arrive
// bien après l'accusé d'envoi.
refuse(
  { body: { ct: b64(64), nonce: b64(16) }, envelopes: envoiValide().envelopes },
  'E2EE_NONCE_TAILLE', 'nonce de 16 octets',
);
refuse(
  { body: { ct: b64(64), nonce: '' }, envelopes: envoiValide().envelopes },
  'E2EE_NONCE_TAILLE', 'nonce absent',
);

// ── Les enveloppes ───────────────────────────────────────────────────────

// Un corps chiffré sans destinataire : personne ne pourra jamais l'ouvrir.
// C'est le défaut le plus coûteux de tous, et le plus facile à produire (un
// client qui échoue à récupérer les bundles et envoie quand même).
refuse(
  { body: envoiValide().body, envelopes: [] },
  'E2EE_ENVELOPPES_MANQUANTES', 'corps chiffré sans aucune enveloppe',
);
refuse(
  { body: envoiValide().body, envelopes: 'non' },
  'E2EE_ENVELOPPES_MANQUANTES', 'enveloppes qui ne sont pas une liste',
);
refuse(
  {
    body: envoiValide().body,
    envelopes: Array.from({ length: ENVELOPPES_MAX + 1 }, (_, i) => ({
      appareilId: i + 100, header: '{}', envType: ENV_CLIQUET, wrappedKey: b64(48),
    })),
  },
  'E2EE_ENVELOPPES_TROP', 'lot au-delà du plafond',
);

// Deux enveloppes pour le même appareil : la seconde écraserait la première
// sous la clé primaire, et c'est le hasard qui dirait laquelle survit.
refuse(
  {
    body: envoiValide().body,
    envelopes: [
      { appareilId: 20, header: '{"n":0}', envType: ENV_CLIQUET, wrappedKey: b64(48) },
      { appareilId: 20, header: '{"n":1}', envType: ENV_CLIQUET, wrappedKey: b64(48) },
    ],
  },
  'E2EE_ENVELOPPE_DOUBLON', 'deux enveloppes pour un même appareil',
);

// L'émetteur ne s'adresse pas d'enveloppe : il détient déjà le clair. En
// accepter une lui ferait consommer un pas de cliquet contre lui-même.
refuse(
  {
    body: envoiValide().body,
    envelopes: [{
      appareilId: MON_APPAREIL, header: '{}', envType: ENV_CLIQUET, wrappedKey: b64(48),
    }],
  },
  'E2EE_ENVELOPPE_EMETTEUR', 'enveloppe adressée à l\'émetteur lui-même',
);

refuse(
  { body: envoiValide().body, envelopes: [{ appareilId: 0, header: '{}', envType: 2, wrappedKey: b64(48) }] },
  'E2EE_ENVELOPPE_INVALIDE', 'appareilId nul',
);
refuse(
  { body: envoiValide().body, envelopes: [{ appareilId: 20, header: '', envType: 2, wrappedKey: b64(48) }] },
  'E2EE_ENVELOPPE_INVALIDE', 'en-tête vide',
);
refuse(
  { body: envoiValide().body, envelopes: [null] },
  'E2EE_ENVELOPPE_INVALIDE', 'enveloppe nulle',
);

// ── L'asymétrie des types : la clé scellée ───────────────────────────────
//
// Deux-à-deux (1, 2) : la clé de contenu est scellée par le cliquet, donc
// `wrappedKey` est obligatoire — sans elle, rien ne s'ouvre.
// Chaîne de groupe (3) : la clé se DÉRIVE de la chaîne que le destinataire
// détient déjà, donc `wrappedKey` n'a pas lieu d'être — sa présence signale
// une confusion de chemin côté client, pas une variante acceptable.

refuse(
  { body: envoiValide().body, envelopes: [{ appareilId: 20, header: '{}', envType: ENV_CLIQUET }] },
  'E2EE_ENVELOPPE_TYPE', 'cliquet sans clé scellée',
);
refuse(
  {
    body: envoiValide().body,
    envelopes: [{
      appareilId: 20, header: '{}', envType: ENV_CHAINE_GROUPE, wrappedKey: b64(48),
    }],
  },
  'E2EE_ENVELOPPE_TYPE', 'chaîne de groupe AVEC clé scellée',
);
refuse(
  { body: envoiValide().body, envelopes: [{ appareilId: 20, header: '{}', envType: 9, wrappedKey: b64(48) }] },
  'E2EE_ENVELOPPE_TYPE', 'type d\'enveloppe inconnu',
);

// Une chaîne de groupe sans clé scellée : c'est la forme correcte.
const groupe = normaliseChiffre({
  body: envoiValide().body,
  envelopes: [{ appareilId: 20, header: '{"c":4}', envType: ENV_CHAINE_GROUPE }],
}, MON_APPAREIL);
assert.strictEqual(groupe.enveloppes[0].wrappedKey, null);
assert.strictEqual(groupe.enveloppes[0].envType, ENV_CHAINE_GROUPE);

// ── Ce qui part vers le client ───────────────────────────────────────────

const corpsLigne = { msgID: 5, body: Buffer.alloc(32, 3), nonce: Buffer.alloc(12, 4) };
const envLigne = {
  msgID: 5, appareil_id: 20, header: '{"n":2}', env_type: 2,
  wrapped_key: Buffer.alloc(48, 6),
};
const sortie = chiffrePourClient(corpsLigne, envLigne);
assert.strictEqual(sortie.body.ct, b64(32, 3));
assert.strictEqual(sortie.envelope.header, '{"n":2}');
assert.strictEqual(sortie.envelope.wrappedKey, b64(48, 6));

// Pas d'enveloppe pour cet appareil : rien n'est rendu. Le client affichera
// « illisible sur cet appareil » plutôt qu'une bulle vide — c'est le cas
// normal d'un appareil enrôlé après coup, ou d'une enveloppe purgée.
assert.strictEqual(
  chiffrePourClient(corpsLigne, undefined), null,
  'sans enveloppe pour cet appareil, aucun paquet n\'est rendu',
);
assert.strictEqual(chiffrePourClient(null, envLigne), null);

// Une chaîne de groupe rend `wrappedKey: null`, jamais un champ absent.
assert.strictEqual(
  chiffrePourClient(corpsLigne, { ...envLigne, env_type: 3, wrapped_key: null })
    .envelope.wrappedKey,
  null,
);

// ── Écritures : rejeu et borne du lot ────────────────────────────────────

(async () => {
  const vues = [];
  const conn = {
    async execute(sql, params) { vues.push({ sql, params }); return [{ affectedRows: 1 }, []]; },
    async query(sql, params) { vues.push({ sql, params }); return [{ affectedRows: 1 }, []]; },
  };

  await ecritChiffre(conn, 42, normaliseChiffre(envoiValide(), MON_APPAREIL));

  assert.match(vues[0].sql, /INSERT INTO message_e2ee/);
  assert.match(
    vues[0].sql, /ON DUPLICATE KEY UPDATE/,
    'le corps doit se réécrire sans échouer : `message:send` est idempotent '
    + 'par clientID, un rejeu retombe sur le même msgID',
  );
  assert.match(vues[1].sql, /INSERT INTO message_envelope/);
  assert.match(
    vues[1].sql, /delivered_at = COALESCE\(delivered_at, delivered_at\)/,
    'un rejeu ne doit JAMAIS effacer delivered_at : sinon la purge garde '
    + 'l\'enveloppe trente jours de plus à chaque rejeu',
  );
  // Une seule requête pour toutes les enveloppes, pas une par ligne.
  assert.strictEqual(vues.length, 2, 'deux requêtes au total, quel que soit le nombre d\'enveloppes');
  assert.strictEqual(vues[1].params.length, 10, '5 paramètres par enveloppe, 2 enveloppes');

  // ── Lecture : rien à faire sans identifiants ni appareil ───────────────

  const vide = {
    async query() { assert.fail('aucune requête ne doit partir'); },
  };
  assert.strictEqual((await chargeChiffrePourAppareil(vide, [], 20)).size, 0);
  assert.strictEqual((await chargeChiffrePourAppareil(vide, [1, 2], null)).size, 0);
  assert.strictEqual((await chargeChiffrePourAppareil(vide, [0, -1, 'x'], 20)).size, 0);

  // Lecture nominale : deux requêtes pour tout le lot, et seule l'enveloppe
  // de CET appareil est jointe — un appareil n'a pas à savoir combien
  // d'appareils ont ses correspondants.
  let nbQuery = 0;
  const lecture = {
    async query(sql, params) {
      nbQuery += 1;
      if (/message_e2ee/.test(sql)) {
        return [[
          { msgID: 5, body: Buffer.alloc(8, 1), nonce: Buffer.alloc(12, 2) },
          { msgID: 6, body: Buffer.alloc(8, 3), nonce: Buffer.alloc(12, 4) },
        ], []];
      }
      assert.strictEqual(params[1], 20, 'la lecture doit filtrer sur l\'appareil demandé');
      return [[{
        msgID: 5, appareil_id: 20, header: '{}', env_type: 2,
        wrapped_key: Buffer.alloc(48, 5),
      }], []];
    },
  };
  const paquets = await chargeChiffrePourAppareil(lecture, [5, 6], 20);
  assert.strictEqual(nbQuery, 2, 'deux requêtes, quel que soit le nombre de messages');
  assert.strictEqual(paquets.size, 1, 'le message 6 n\'a pas d\'enveloppe pour cet appareil');
  assert.ok(paquets.has(5));
  assert.ok(!paquets.has(6));

  // ── Marquage de remise ────────────────────────────────────────────────

  const remise = [];
  const connRemise = {
    async query(sql, params) { remise.push({ sql, params }); return [{ affectedRows: 2 }, []]; },
  };
  assert.strictEqual(await marqueRemises(connRemise, [5, 6], 20), 2);
  assert.match(
    remise[0].sql, /delivered_at IS NULL/,
    'ne réécrire que ce qui n\'est pas déjà remis : une date de remise ne bouge pas',
  );
  assert.strictEqual(await marqueRemises(connRemise, [], 20), 0);

  console.log('messageEnvelopes.test.js OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
