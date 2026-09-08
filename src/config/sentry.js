/**
 * Rapport d'erreurs backend.
 *
 * `SENTRY_DSN` absent : le SDK n'est pas initialisé du tout, et toutes les
 * fonctions de ce module deviennent des passe-plats. Même contrat que
 * `REDIS_URL` — le développement local et la CI n'envoient jamais rien, sans
 * qu'aucun code appelant n'ait à s'en soucier.
 *
 * ── Ce module doit être requis EN PREMIER dans server.js ──
 *
 * Le SDK instrumente Express, MySQL et HTTP en remplaçant leurs modules au
 * chargement. Initialisé après eux, il n'accroche plus rien : les erreurs
 * arriveraient sans contexte de requête, et la plupart n'arriveraient pas du
 * tout.
 */

const fs = require('fs');
const path = require('path');
const Sentry = require('@sentry/node');
require('dotenv').config();

const DSN = process.env.SENTRY_DSN || null;
const SENTRY_ACTIF = !!DSN;

/**
 * Le commit déployé, pour que Sentry range chaque erreur sous sa version.
 * Sans lui, on voit qu'une erreur est apparue ; avec lui, on sait quel
 * déploiement l'a introduite.
 *
 * Lu dans `.git` plutôt que via `git rev-parse` : le déploiement fait un
 * `git reset --hard origin/main`, le dépôt est donc bien là, et une lecture de
 * fichier évite de lancer un processus au démarrage. `SENTRY_RELEASE` prime,
 * pour le cas où le serveur tournerait un jour depuis une archive sans `.git`.
 */
function versionDeployee() {
  if (process.env.SENTRY_RELEASE) return process.env.SENTRY_RELEASE;
  try {
    const git = path.join(__dirname, '../../.git');
    const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head; // HEAD détaché : déjà un SHA
    const ref = head.slice(4).trim();
    const direct = path.join(git, ref);
    if (fs.existsSync(direct)) return fs.readFileSync(direct, 'utf8').trim();
    // Référence empaquetée (packed-refs) : le fichier de branche n'existe pas.
    const packed = fs.readFileSync(path.join(git, 'packed-refs'), 'utf8');
    const ligne = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
    return ligne ? ligne.split(' ')[0] : null;
  } catch {
    return null;
  }
}

// ── Expurgation ────────────────────────────────────────────────────────
//
// ALANYA est une messagerie : une trace d'erreur ou un contexte de requête peut
// charrier le texte d'un message, un numéro de téléphone, un jeton. Rien de
// tout cela n'a à sortir du serveur. L'expurgation est donc une exigence de ce
// module, pas une option de configuration que l'on pourrait oublier de poser.

const EN_TETES_SENSIBLES = ['authorization', 'cookie', 'x-api-key', 'proxy-authorization'];

// Champs dont la valeur est remplacée partout où elle apparaît dans l'événement.
const CHAMPS_SENSIBLES = new Set([
  'password', 'motdepasse', 'token', 'accesstoken', 'refreshtoken', 'authorization',
  'ciphertext', 'content', 'contenu', 'message', 'texte', 'text', 'body',
  'phone', 'telephone', 'email', 'otp', 'code', 'secret', 'dsn',
]);

function expurger(valeur, profondeur = 0) {
  if (profondeur > 6 || valeur === null || typeof valeur !== 'object') return valeur;
  if (Array.isArray(valeur)) return valeur.map((v) => expurger(v, profondeur + 1));
  const sortie = {};
  for (const [cle, v] of Object.entries(valeur)) {
    sortie[cle] = CHAMPS_SENSIBLES.has(cle.toLowerCase()) ? '[expurgé]' : expurger(v, profondeur + 1);
  }
  return sortie;
}

function beforeSend(evenement) {
  if (evenement.request) {
    // Le corps de requête n'est jamais transmis : c'est là que voyage le texte
    // des messages.
    delete evenement.request.data;
    delete evenement.request.cookies;
    if (evenement.request.headers) {
      for (const h of Object.keys(evenement.request.headers)) {
        if (EN_TETES_SENSIBLES.includes(h.toLowerCase())) evenement.request.headers[h] = '[expurgé]';
      }
    }
    // La chaîne de requête peut porter un jeton (liens de partage, QR).
    if (evenement.request.query_string) evenement.request.query_string = '[expurgé]';
  }
  if (evenement.extra) evenement.extra = expurger(evenement.extra);
  if (evenement.contexts) evenement.contexts = expurger(evenement.contexts);
  return evenement;
}

if (SENTRY_ACTIF) {
  Sentry.init({
    dsn: DSN,
    release: versionDeployee() || undefined,
    environment: process.env.NODE_ENV || 'production',
    // Aucune donnée personnelle déduite automatiquement : ni adresse IP, ni
    // en-têtes de requête complets, ni identité de l'utilisateur connecté.
    sendDefaultPii: false,
    // Les traces de performance sont hors périmètre : on veut des erreurs, pas
    // un profil. Elles s'activeraient par un `tracesSampleRate` non nul.
    tracesSampleRate: 0,
    beforeSend,
  });
  console.log('[Sentry] rapport d’erreurs actif — version', versionDeployee() || 'inconnue');
} else {
  console.log('[Sentry] SENTRY_DSN absent — rapport d’erreurs désactivé');
}

/** Capture une erreur. Sans DSN, ne fait rien. */
function capturer(erreur) {
  if (SENTRY_ACTIF) Sentry.captureException(erreur);
}

/**
 * Vide la file d'envoi avant une sortie de processus.
 *
 * Sans ce vidage, l'erreur fatale — précisément celle qu'on veut voir — reste
 * dans le tampon et part avec le processus. `flush` ne rejette pas ; le `catch`
 * garantit qu'un Sentry injoignable ne retarde jamais un arrêt.
 */
async function vider(msMax = 2000) {
  if (!SENTRY_ACTIF) return;
  await Sentry.flush(msMax).catch(() => {});
}

// `beforeSend` est exporté pour être vérifiable : l'expurgation est la partie
// dont une régression serait à la fois invisible et grave — on ne s'apercevrait
// d'une fuite qu'en lisant un jour un message d'utilisateur dans Sentry.
module.exports = { Sentry, SENTRY_ACTIF, capturer, vider, beforeSend };
