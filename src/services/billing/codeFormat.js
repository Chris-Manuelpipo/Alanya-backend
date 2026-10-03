/**
 * Format des codes d'activation : fonctions pures, aucune base.
 *
 * Un code se tape au clavier d'un téléphone, d'après un écran ou un e-mail :
 * l'alphabet Crockford écarte I, L, O et U (confondus avec 1 et 0, ou
 * grossiers), 14 symboles tirés au hasard donnent 70 bits — hors de portée
 * d'une énumération limitée à cinq essais par quart d'heure — et un quinzième
 * symbole de contrôle laisse l'application refuser une faute de frappe sans
 * même interroger le serveur.
 *
 * Forme canonique : 15 symboles sans séparateur. Forme affichée :
 * `XXXXX-XXXXX-XXXXX`. Le code n'est jamais stocké : seul son HMAC l'est
 * (`hashCode`), signé par `ACTIVATION_CODE_SECRET`.
 */

const crypto = require('crypto');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DATA_LENGTH = 14;
const CODE_LENGTH = DATA_LENGTH + 1;
// Poids impairs, modulo 32 : un poids impair est premier avec 32, donc la
// substitution d'UN symbole par un autre change toujours le contrôle. Les
// poids qui diffèrent de 2 détectent aussi l'inversion de deux symboles voisins,
// sauf quand leurs valeurs diffèrent de 16.
const CHECK_MODULUS = 32;

const valueOf = (char) => ALPHABET.indexOf(char);

/** Symbole de contrôle d'une suite de symboles de données. */
function checkSymbol(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += valueOf(data[i]) * (2 * i + 1);
  return ALPHABET[sum % CHECK_MODULUS];
}

/** Un code neuf, en forme canonique (15 symboles). */
function generateCode() {
  let data = '';
  for (let i = 0; i < DATA_LENGTH; i++) data += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return data + checkSymbol(data);
}

/** `XXXXX-XXXXX-XXXXX`, pour l'écran, l'e-mail et le fichier d'export. */
function formatCode(canonical) {
  return String(canonical).match(/.{1,5}/g).join('-');
}

/**
 * Ce que l'utilisateur a saisi, ramené à la forme canonique.
 *
 * Majuscules, séparateurs et espaces ignorés, et les confusions usuelles
 * corrigées (O→0, I et L→1) : on ne refuse pas un code parce qu'il a été lu de
 * travers sur un écran.
 *
 * `reason` : `format` (longueur ou symbole impossible) ou `checksum` (saisie
 * bien formée, mais le contrôle échoue : faute de frappe). Ni l'une ni l'autre
 * ne compte comme une tentative — aucune ne peut réussir.
 *
 * @returns {{ ok: true, canonical: string } | { ok: false, reason: 'format' | 'checksum' }}
 */
function parseCode(input) {
  const cleaned = String(input ?? '')
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (cleaned.length !== CODE_LENGTH) return { ok: false, reason: 'format' };
  for (const char of cleaned) {
    if (valueOf(char) < 0) return { ok: false, reason: 'format' };
  }
  if (checkSymbol(cleaned.slice(0, DATA_LENGTH)) !== cleaned[DATA_LENGTH]) {
    return { ok: false, reason: 'checksum' };
  }
  return { ok: true, canonical: cleaned };
}

/** HMAC-SHA256 hexadécimal du code canonique : ce qui se stocke et se cherche. */
function hashCode(canonical, secret) {
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

/** Les quatre derniers symboles, pour retrouver un code au support sans le révéler. */
function hintOf(canonical) {
  return canonical.slice(-4);
}

// ── Tentatives ──────────────────────────────────────────────────────────

const ATTEMPT_WINDOW_MS = 15 * 60_000;
const ATTEMPT_MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

/**
 * État des échecs d'un compte après un échec de plus. Pure : la base ne fait
 * que le porter (code_attempt), sous verrou de ligne.
 *
 * Cinq échecs dans un quart d'heure verrouillent le compte un quart d'heure.
 * Passé la fenêtre, le compte repart de un.
 *
 * @param {{ failures: number, window_start: Date|string, locked_until: Date|string|null }|null} state
 */
function attemptAfterFailure(state, now = new Date()) {
  const start = state ? new Date(state.window_start) : null;
  const fresh = !start || Number.isNaN(start.getTime()) || now.getTime() - start.getTime() > ATTEMPT_WINDOW_MS;
  const failures = fresh ? 1 : Number(state.failures) + 1;
  const windowStart = fresh ? now : start;
  const previousLock = state?.locked_until ? new Date(state.locked_until) : null;
  const lockedUntil = failures >= ATTEMPT_MAX_FAILURES
    ? new Date(now.getTime() + LOCK_MS)
    : previousLock;
  return { failures, windowStart, lockedUntil };
}

/** Secondes avant la fin du verrou, ou 0 s'il n'y en a pas. */
function lockRemainingSeconds(lockedUntil, now = new Date()) {
  if (!lockedUntil) return 0;
  const ms = new Date(lockedUntil).getTime() - now.getTime();
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}

module.exports = {
  ALPHABET,
  CODE_LENGTH,
  ATTEMPT_MAX_FAILURES,
  checkSymbol,
  generateCode,
  formatCode,
  parseCode,
  hashCode,
  hintOf,
  attemptAfterFailure,
  lockRemainingSeconds,
};
