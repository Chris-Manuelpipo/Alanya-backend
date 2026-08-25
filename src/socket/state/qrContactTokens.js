// Jetons éphémères d'ajout de contact par QR : l'utilisateur génère un code à
// la demande, valable dix minutes, consommé au premier scan réussi. C'est le
// régime des comptes personnels — le code permanent (users.qr_public_id) est
// réservé aux futurs comptes business.
//
// Deux implémentations : Redis si REDIS_URL est configuré (jetons partagés
// entre instances), sinon repli sur des Map locales au process.
//
// Le contrat produit est « une seule personne » : c'est ce que dit l'écran.
// Le tenir demande que la vérification et la consommation soient une seule
// opération — voir `claim`.

const { generateOpaqueToken } = require('../../utils/qrToken');
const { getDataClient } = require('../../config/redisData');
const { runScript } = require('../../utils/redisScript');

const TTL_MS = 10 * 60 * 1000; // durée d'affichage annoncée à l'utilisateur

const keyOf = (token) => `alanya:qrContactTokens:${token}`;
// Un seul code vivant par utilisateur : en générer un nouveau invalide le
// précédent, ce qui rend la création autolimitante et épargne un limiteur
// dédié sur la route.
const actifKeyOf = (alanyaID) => `alanya:qrContactActif:${Number(alanyaID)}`;

// ── Repli mémoire ───────────────────────────────────────────────────────────

const _tokens = new Map();
const _actifParUtilisateur = new Map();

// Même filet que qrLoginSessions : la route de création est authentifiée mais
// rien n'empêche un client de créer sans jamais faire scanner. Côté Redis, le
// TTL natif joue ce rôle.
const MAX_TOKENS = 10000;
const SWEEP_PER_CREATE = 20;

function _delete(entry) {
  _tokens.delete(entry.token);
  if (_actifParUtilisateur.get(entry.alanyaID) === entry.token) {
    _actifParUtilisateur.delete(entry.alanyaID);
  }
}

function _sweep() {
  const now = Date.now();
  let vus = 0;
  for (const [, entry] of _tokens) {
    if (vus++ >= SWEEP_PER_CREATE) break;
    if (now > entry.expiresAt) _delete(entry);
  }
  while (_tokens.size >= MAX_TOKENS) {
    const plusAncien = _tokens.values().next();
    if (plusAncien.done) break;
    _delete(plusAncien.value);
  }
}

// Expiration paresseuse : pas de setInterval, un jeton périmé disparaît à la
// première lecture qui le rencontre.
function _memGet(token) {
  if (!token) return null;
  const entry = _tokens.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _delete(entry);
    return null;
  }
  return entry;
}

// ── Redis ───────────────────────────────────────────────────────────────────

function _depuisHash(h) {
  if (!h || !h.token) return null;
  return {
    token: h.token,
    alanyaID: Number(h.alanyaID),
    createdAt: Number(h.createdAt),
    expiresAt: Number(h.expiresAt),
    claimed: h.claimed === '1',
  };
}

/**
 * Réservation atomique : marque le jeton comme pris, et refuse si un autre
 * scan l'a déjà réservé.
 */
const CLAIM = `
local pris = redis.call('HGET', KEYS[1], 'claimed')
if not pris then return 'ABSENT' end
if pris == '1' then return 'DEJA' end
redis.call('HSET', KEYS[1], 'claimed', '1')
return 'OK'
`;

// ── API publique ────────────────────────────────────────────────────────────

async function create(alanyaID) {
  if (alanyaID == null) return null;
  const now = Date.now();
  const entry = {
    token: generateOpaqueToken(16),
    alanyaID,
    createdAt: now,
    expiresAt: now + TTL_MS,
    claimed: false,
  };

  const client = getDataClient();
  if (client) {
    const precedent = await client.get(actifKeyOf(alanyaID));
    if (precedent) await client.del(keyOf(precedent));
    await client.hSet(keyOf(entry.token), {
      token: entry.token,
      alanyaID: String(alanyaID),
      createdAt: String(entry.createdAt),
      expiresAt: String(entry.expiresAt),
      claimed: '0',
    });
    await client.pExpire(keyOf(entry.token), TTL_MS);
    await client.set(actifKeyOf(alanyaID), entry.token, { PX: TTL_MS });
    return entry;
  }

  _sweep();
  const precedent = _actifParUtilisateur.get(alanyaID);
  if (precedent != null) _tokens.delete(precedent);
  _tokens.set(entry.token, entry);
  _actifParUtilisateur.set(alanyaID, entry.token);
  return entry;
}

/** Lecture seule, sans effet — sert à l'affichage de la page d'accueil du QR. */
async function get(token) {
  const client = getDataClient();
  if (client) {
    if (!token) return null;
    const entry = _depuisHash(await client.hGetAll(keyOf(token)));
    // Un jeton réservé par un ajout en cours ne doit plus être présenté comme
    // disponible : la page afficherait « code valide » à un second scanneur.
    return entry && !entry.claimed ? entry : null;
  }
  const entry = _memGet(token);
  return entry && !entry.claimed ? entry : null;
}

/**
 * Réserve le jeton AVANT l'ajout du contact — puis `commit` ou `release`.
 *
 * L'ancien `consume()` lisait le jeton, laissait l'ajout du contact se faire
 * (plusieurs allers-retours en base), et ne le supprimait qu'ensuite. Deux
 * scans du même code passaient donc tous deux la vérification avant que le
 * premier n'ait consommé : les deux ajouts aboutissaient, et le propriétaire
 * était prévenu deux fois. La course existait déjà en production, avant même
 * toute question de multi-instance ; la répartir n'aurait fait qu'élargir la
 * fenêtre.
 *
 * Réserver d'abord ferme cette fenêtre. `release` remet le jeton en circulation
 * si l'ajout échoue, pour qu'un scan raté ne tue pas le code de son détenteur.
 *
 * @returns {object|null} l'entrée si CE scan a emporté la réservation.
 */
async function claim(token) {
  if (!token) return null;
  const client = getDataClient();
  if (client) {
    const res = await runScript(client, CLAIM, [keyOf(token)], []);
    if (res !== 'OK') return null;
    return _depuisHash(await client.hGetAll(keyOf(token)));
  }
  const entry = _memGet(token);
  if (!entry || entry.claimed) return null;
  entry.claimed = true;
  return entry;
}

/** L'ajout a échoué : le code redevient utilisable. */
async function release(token) {
  if (!token) return;
  const client = getDataClient();
  if (client) {
    // Ne pas ressusciter une clé expirée entre-temps : HSET recréerait un
    // jeton sans TTL, donc éternel.
    if (await client.exists(keyOf(token))) {
      await client.hSet(keyOf(token), 'claimed', '0');
    }
    return;
  }
  const entry = _tokens.get(token);
  if (entry) entry.claimed = false;
}

/** L'ajout a réussi : le jeton disparaît définitivement (usage unique). */
async function commit(token) {
  if (!token) return;
  const client = getDataClient();
  if (client) {
    const h = await client.hGetAll(keyOf(token));
    await client.del(keyOf(token));
    // Ne libérer le pointeur « jeton actif » que s'il désigne bien celui-ci :
    // l'utilisateur a pu en générer un nouveau entre-temps.
    if (h && h.alanyaID) {
      const actif = await client.get(actifKeyOf(h.alanyaID));
      if (actif === token) await client.del(actifKeyOf(h.alanyaID));
    }
    return;
  }
  const entry = _tokens.get(token);
  if (entry) _delete(entry);
}

async function clear(token) {
  await commit(token);
}

/** Réservé aux tests du repli mémoire. */
function _reset() {
  _tokens.clear();
  _actifParUtilisateur.clear();
}

module.exports = { TTL_MS, create, get, claim, release, commit, clear, _reset };
