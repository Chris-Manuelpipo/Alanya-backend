// Jetons éphémères d'ajout de contact par QR : l'utilisateur génère un code à
// la demande, valable dix minutes, consommé au premier scan réussi. C'est le
// régime des comptes personnels — le code permanent (users.qr_public_id) est
// réservé aux futurs comptes business.
//
// Un état en mémoire suffit, comme pour pendingCalls.js et qrLoginSessions.js :
// le déploiement est mono-processus (pm2 sans mode cluster), et perdre un jeton
// à un redémarrage ne coûte qu'une régénération — l'écran la fait tout seul.

const { generateOpaqueToken } = require('../../utils/qrToken');

const TTL_MS = 10 * 60 * 1000; // durée d'affichage annoncée à l'utilisateur

// token -> { token, alanyaID, createdAt, expiresAt }
const _tokens = new Map();

// alanyaID -> token actif. Un seul code vivant par utilisateur : en générer un
// nouveau invalide le précédent, ce qui rend la création autolimitante et
// épargne un limiteur dédié sur la route.
const _actifParUtilisateur = new Map();

// Même filet que qrLoginSessions : la route de création est authentifiée mais
// rien n'empêche un client de créer sans jamais faire scanner. On balaie un
// échantillon à chaque création et on évince en FIFO au-delà du plafond.
const MAX_TOKENS = 10000;
const SWEEP_PER_CREATE = 20;

function _sweep() {
  const now = Date.now();
  let vus = 0;
  for (const [token, entry] of _tokens) {
    if (vus++ >= SWEEP_PER_CREATE) break;
    if (now > entry.expiresAt) _delete(entry);
  }
  while (_tokens.size >= MAX_TOKENS) {
    const plusAncien = _tokens.values().next();
    if (plusAncien.done) break;
    _delete(plusAncien.value);
  }
}

function _delete(entry) {
  _tokens.delete(entry.token);
  if (_actifParUtilisateur.get(entry.alanyaID) === entry.token) {
    _actifParUtilisateur.delete(entry.alanyaID);
  }
}

function create(alanyaID) {
  if (alanyaID == null) return null;
  _sweep();

  const precedent = _actifParUtilisateur.get(alanyaID);
  if (precedent != null) _tokens.delete(precedent);

  const now = Date.now();
  const entry = {
    token: generateOpaqueToken(16),
    alanyaID,
    createdAt: now,
    expiresAt: now + TTL_MS,
  };
  _tokens.set(entry.token, entry);
  _actifParUtilisateur.set(alanyaID, entry.token);
  return entry;
}

// Expiration paresseuse : pas de setInterval, un jeton périmé disparaît à la
// première lecture qui le rencontre.
function _getEntry(token) {
  if (!token) return null;
  const entry = _tokens.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _delete(entry);
    return null;
  }
  return entry;
}

function get(token) {
  return _getEntry(token);
}

/**
 * Lit ET supprime le jeton — l'usage unique du contrat produit. À n'appeler
 * qu'une fois l'ajout réellement effectué : consommer avant l'écriture
 * laisserait un scan échoué tuer le code pour rien.
 */
function consume(token) {
  const entry = _getEntry(token);
  if (!entry) return null;
  _delete(entry);
  return entry;
}

function clear(token) {
  const entry = _tokens.get(token);
  if (entry) _delete(entry);
}

module.exports = { TTL_MS, create, get, consume, clear };
