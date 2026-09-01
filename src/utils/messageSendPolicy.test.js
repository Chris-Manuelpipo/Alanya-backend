const assert = require('assert');

/**
 * `resolveSendPolicy` fusionne quatre requêtes en deux sur le chemin d'envoi.
 * Ces tests figent deux choses : les verdicts (identiques à l'enchaînement
 * `assertCanSendToConversation` + `evaluateDirectMessageSend` qu'elle remplace)
 * et le nombre d'allers-retours, qui est toute la raison d'être du module.
 */

// Faux pool injecté avant le chargement du module testé : `messageSendPolicy`
// et `directConversation` recevront celui-ci au lieu d'ouvrir une connexion.
const dbPath = require.resolve('../config/db');
const calls = [];
let responses = [];
const fakePool = {
  execute: async (sql, params) => {
    calls.push({ sql, params });
    const next = responses.shift();
    return [next ?? [], []];
  },
};
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: fakePool,
};

const { resolveSendPolicy } = require('./messageSendPolicy');

const SELF_CHAT_MARKER = '__self__';
const ME = 7;
const PEER = 9;
const CONV = 42;

function run(rows) {
  calls.length = 0;
  responses = rows;
  return resolveSendPolicy(CONV, ME);
}

/** Ligne conversation telle que la première requête la rend. */
function conv(over = {}) {
  return [{
    isGroup: 0,
    GroupName: null,
    onlyAdminsCanSend: 0,
    role: 0,
    peerCount: 1,
    peerId: PEER,
    ...over,
  }];
}

/** Ligne pair telle que la seconde requête la rend. */
function peer(over = {}) {
  return [{ account_type: 0, iBlockedThem: 0, theyBlockedMe: 0, ...over }];
}

(async () => {
  // ── Refus ────────────────────────────────────────────────────────────────
  let r = await run([[]]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'CONVERSATION_NOT_FOUND');
  assert.strictEqual(calls.length, 1, 'conversation absente : une seule requête');

  r = await run([conv({ role: null })]);
  assert.strictEqual(r.code, 'NOT_A_MEMBER', 'LEFT JOIN sans rôle = non membre');
  assert.strictEqual(calls.length, 1);

  r = await run([conv({ isGroup: 1, onlyAdminsCanSend: 1, role: 0, peerCount: 5 })]);
  assert.strictEqual(r.code, 'GROUP_ADMINS_ONLY');

  // Admin d'un groupe en mode annonce : passe.
  r = await run([conv({ isGroup: 1, onlyAdminsCanSend: 1, role: 1, peerCount: 5 })]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.isDirect, false);

  // ── Groupes : jamais de seconde requête ──────────────────────────────────
  r = await run([conv({ isGroup: 1, peerCount: 4, peerId: PEER })]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.isDirect, false, 'un groupe échappe à la politique de blocage');
  assert.strictEqual(r.silentDrop, false);
  assert.strictEqual(calls.length, 1, 'groupe : une seule requête, pas de lecture du pair');

  // Conversation avec soi-même : pas de pair, donc pas de blocage possible.
  r = await run([conv({ GroupName: SELF_CHAT_MARKER })]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.isDirect, false, 'la conversation avec soi-même n\'a pas de pair');
  assert.strictEqual(calls.length, 1);

  // Plus d'un autre participant sans drapeau de groupe : pas un vrai 1-1.
  r = await run([conv({ peerCount: 3 })]);
  assert.strictEqual(r.isDirect, false);
  assert.strictEqual(calls.length, 1);

  // ── 1-1 : deux requêtes, jamais plus ─────────────────────────────────────
  r = await run([conv(), peer()]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.isDirect, true);
  assert.strictEqual(r.peerId, PEER);
  assert.strictEqual(r.silentDrop, false);
  assert.strictEqual(calls.length, 2, '1-1 : deux requêtes au total, contre quatre avant');
  // Les blocages se lisent bien dans les deux sens, avec les bons paramètres.
  assert.deepStrictEqual(
    calls[1].params,
    [ME, PEER, PEER, ME, PEER],
    'ordre des paramètres : (moi→lui), (lui→moi), puis l\'id du pair',
  );

  r = await run([conv(), peer({ account_type: 2 })]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'OFFICIAL_READONLY', 'un compte officiel est en lecture seule');

  r = await run([conv(), peer({ iBlockedThem: 1 })]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'BLOCKED_BY_SENDER');

  // Bloqué PAR le destinataire : le message part et est persisté, mais n'est
  // ni diffusé ni compté chez lui. C'est un envoi accepté, pas un refus.
  r = await run([conv(), peer({ theyBlockedMe: 1 })]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.silentDrop, true);

  // Le blocage dans mon sens l'emporte sur celui du pair.
  r = await run([conv(), peer({ iBlockedThem: 1, theyBlockedMe: 1 })]);
  assert.strictEqual(r.code, 'BLOCKED_BY_SENDER');

  // Pair introuvable : on n'invente pas un refus sur une donnée manquante.
  r = await run([conv(), []]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.silentDrop, false);

  // MySQL rend EXISTS en 0/1 numérique ; certains pilotes en font des chaînes.
  r = await run([conv(), peer({ theyBlockedMe: '1' })]);
  assert.strictEqual(r.silentDrop, true, 'EXISTS rendu en chaîne doit compter comme vrai');

  console.log('messageSendPolicy.test.js OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
