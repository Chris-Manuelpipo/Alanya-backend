const { ACCOUNT_TYPE } = require('../constants/accountTypes');

const OFFICIAL_BRAND = 'alanya';
const OFFICIAL_PREFIXES = ['alanya support', 'alanya news'];

const HOMOGLYPH_MAP = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x',
  Α: 'a', Β: 'b', Ε: 'e', Η: 'h', Ι: 'i', Κ: 'k', Μ: 'm',
  Ν: 'n', Ο: 'o', Ρ: 'p', Τ: 't', Χ: 'x',
  Ａ: 'a', ａ: 'a', ｌ: 'l', ｎ: 'n', ｙ: 'y',
};

const normalizeForGuard = (value) => {
  const lower = String(value || '').trim().toLowerCase();
  let out = '';
  for (const ch of lower) {
    out += HOMOGLYPH_MAP[ch] ?? ch;
  }
  return out.replace(/\s+/g, ' ');
};

const isReservedBrand = (normalized) => {
  if (normalized === OFFICIAL_BRAND) return true;
  return OFFICIAL_PREFIXES.some((p) => normalized === p || normalized.startsWith(`${p} `));
};

const isAllowedOfficialName = (normalized) => {
  if (normalized === OFFICIAL_BRAND) return true;
  return OFFICIAL_PREFIXES.some((p) => normalized === p || normalized.startsWith(`${p} `));
};

/**
 * @param {{ nom?: string, pseudo?: string, accountType?: number, allowOfficialBrandName?: boolean }} input
 */
const guardDisplayNames = (input = {}) => {
  const accountType = input.accountType ?? ACCOUNT_TYPE.PERSONNEL;
  const allowOfficial = input.allowOfficialBrandName === true
    || accountType === ACCOUNT_TYPE.OFFICIEL;

  for (const field of ['nom', 'pseudo']) {
    const raw = input[field];
    if (raw == null || String(raw).trim() === '') continue;
    const normalized = normalizeForGuard(raw);
    if (isReservedBrand(normalized)) {
      if (allowOfficial && isAllowedOfficialName(normalized)) continue;
      return {
        ok: false,
        code: 'RESERVED_BRAND_NAME',
        message: `Le ${field} « ${raw} » est réservé au compte officiel Alanya`,
        field,
      };
    }
  }
  return { ok: true };
};

module.exports = {
  guardDisplayNames,
  normalizeForGuard,
  isReservedBrand,
  isAllowedOfficialName,
};
