const pool = require('../config/db');
const {
  generateRandom,
  validate,
  isPatternReserved,
} = require('../utils/alanyaPhone');

const phoneExists = async (canonical) => {
  const [rows] = await pool.execute(
    'SELECT alanyaID FROM users WHERE alanyaPhone = ?',
    [canonical]
  );
  return rows.length > 0;
};

const isInReservedTable = async (canonical) => {
  const [rows] = await pool.execute(
    'SELECT id FROM reserved_alanya_phone WHERE phone_canonical = ?',
    [canonical]
  );
  return rows.length > 0;
};

/** Réservé = pattern (3 / 4 / XXYYZZTT) OU présent en table admin. */
const isReserved = async (canonical) => {
  if (isPatternReserved(canonical)) return true;
  return isInReservedTable(canonical);
};

const isPhoneAvailable = async (canonical) => {
  if (await phoneExists(canonical)) return false;
  if (await isReserved(canonical)) return false;
  return true;
};

const generateUniquePhone = async (length, { allowReserved = false } = {}) => {
  const check = validate(String('0'.repeat(length)));
  if (!check.ok && length !== 3 && length !== 4 && length !== 8) {
    throw new Error(`Longueur invalide : ${length}`);
  }

  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = generateRandom(length);
    if (!allowReserved) {
      if (isPatternReserved(candidate)) continue;
      if (await isInReservedTable(candidate)) continue;
    }
    if (!(await phoneExists(candidate))) return candidate;
  }
  throw new Error(`Impossible de générer un alanyaPhone unique (${length} ch.) après 50 tentatives`);
};

module.exports = {
  phoneExists,
  isInReservedTable,
  isReserved,
  isPhoneAvailable,
  generateUniquePhone,
};
