const VALID_LENGTHS = [3, 4, 8];

const normalize = (input) => {
  if (input == null) return '';
  return String(input).replace(/\D/g, '');
};

const getTier = (canonical) => {
  const len = canonical.length;
  return VALID_LENGTHS.includes(len) ? len : null;
};

const validate = (canonical) => {
  if (!canonical) {
    return { ok: false, error: 'Numéro Alanya requis' };
  }
  if (!/^\d+$/.test(canonical)) {
    return { ok: false, error: 'Le numéro ne doit contenir que des chiffres' };
  }
  const tier = getTier(canonical);
  if (!tier) {
    return { ok: false, error: 'Numéro invalide : 3, 4 ou 8 chiffres requis' };
  }
  return { ok: true, tier };
};

const _groupDigits = (digits, groups) => {
  const parts = [];
  let i = 0;
  for (const size of groups) {
    if (i >= digits.length) break;
    parts.push(digits.slice(i, i + size));
    i += size;
  }
  if (i < digits.length) {
    parts.push(digits.slice(i));
  }
  return parts.join(' ');
};

const formatDisplay = (canonical) => {
  let digits = normalize(canonical);
  if (!digits) return '';

  // Legacy 5–7 chiffres (ex. anciens 6 ch.) : aligner sur le schéma 8 chiffres
  if (digits.length >= 5 && digits.length <= 7) {
    digits = digits.padStart(8, '0');
  }

  if (digits.length <= 3) return digits;
  // 4+ : groupes de 2 (8 ch. Alanya, et numéros plus longs type indicatif)
  const groups = Array(Math.ceil(digits.length / 2)).fill(2);
  return _groupDigits(digits, groups);
};

const formatLiveInput = (input) => {
  const digits = normalize(input);
  if (!digits) return '';
  if (digits.length <= 3) return digits;
  if (digits.length <= 4) return _groupDigits(digits, [2, 2]);
  return _groupDigits(digits.slice(0, 8), [2, 2, 2, 2]);
};

const generateRandom = (length) => {
  if (!VALID_LENGTHS.includes(length)) {
    throw new Error(`Longueur invalide pour génération : ${length}`);
  }
  const max = 10 ** length;
  const n = Math.floor(Math.random() * max);
  return String(n).padStart(length, '0');
};

/** Forme XXYYZZTT (ex. 11223344, 00001122). */
const isXxyyzztt = (canonical) =>
  typeof canonical === 'string' &&
  canonical.length === 8 &&
  /^\d{8}$/.test(canonical) &&
  canonical[0] === canonical[1] &&
  canonical[2] === canonical[3] &&
  canonical[4] === canonical[5] &&
  canonical[6] === canonical[7];

/**
 * Règles de réservation (en code, pas toutes en BD) :
 * - tous les numéros à 3 chiffres
 * - tous les numéros à 4 chiffres
 * - 8 chiffres de la forme XXYYZZTT
 */
const isPatternReserved = (canonical) => {
  if (!canonical || !/^\d+$/.test(canonical)) return false;
  const len = canonical.length;
  if (len === 3 || len === 4) return true;
  if (len === 8) return isXxyyzztt(canonical);
  return false;
};

const validateReservedCandidate = (canonical) => {
  const v = validate(canonical);
  if (!v.ok) return v;
  if (!isPatternReserved(canonical)) {
    return {
      ok: false,
      error:
        'Ce numéro ne peut pas être réservé : 3 ou 4 chiffres, ou 8 chiffres au format XXYYZZTT (ex. 11 22 33 44)',
    };
  }
  return { ok: true, tier: v.tier };
};

const isNumericQuery = (q) => /^\d+$/.test(normalize(q));

module.exports = {
  VALID_LENGTHS,
  normalize,
  getTier,
  validate,
  formatDisplay,
  formatLiveInput,
  generateRandom,
  isXxyyzztt,
  isPatternReserved,
  validateReservedCandidate,
  isNumericQuery,
};
