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
  const digits = normalize(canonical);
  if (!digits) return '';
  const tier = getTier(digits);
  if (tier === 3) return digits;
  if (tier === 4) return _groupDigits(digits, [2, 2]);
  if (tier === 8) return _groupDigits(digits, [2, 2, 2, 2]);
  return digits;
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

const isNumericQuery = (q) => /^\d+$/.test(normalize(q));

module.exports = {
  VALID_LENGTHS,
  normalize,
  getTier,
  validate,
  formatDisplay,
  formatLiveInput,
  generateRandom,
  isNumericQuery,
};
