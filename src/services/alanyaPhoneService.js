const pool = require('../config/db');
const {
  generateRandom,
  validate,
  isPatternReserved,
  purchaseRefusal,
} = require('../utils/alanyaPhone');
const { PHONE_ORDER_STATUS: O, PHONE_CHANGE } = require('../constants/billing');

const DAY_MS = 86_400_000;

const phoneExists = async (canonical, conn = pool) => {
  const [rows] = await conn.execute(
    'SELECT alanyaID FROM users WHERE alanyaPhone = ?',
    [canonical]
  );
  return rows.length > 0;
};

const isInReservedTable = async (canonical, conn = pool) => {
  const [rows] = await conn.execute(
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

/**
 * Les tables du numéro choisi (migration 089) sont lues par l'inscription, via
 * `generateUniquePhone`. Si le code part avant la migration, une table absente
 * ne doit pas empêcher de créer un compte : elle ne retient aucun numéro et
 * n'en met aucun en quarantaine.
 */
const tolerateMissingTable = async (fn, fallback) => {
  try {
    return await fn();
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return fallback;
    throw err;
  }
};

/**
 * Retenu par un autre compte que `exceptUser` : mise de côté non échue, ou
 * paiement en cours. Celui-ci ne s'échoit pas à l'heure : il attend la
 * réponse de l'opérateur, ou l'expiration du paiement, qui abandonne la
 * commande dans la même transaction.
 */
const isHeld = (canonical, { exceptUser = null, now = new Date(), conn = pool } = {}) =>
  tolerateMissingTable(async () => {
    const [rows] = await conn.execute(
      `SELECT alanyaID FROM alanya_phone_order
        WHERE active_phone = ? AND (status = ? OR held_until > ?)`,
      [canonical, O.PAYING, now],
    );
    return rows.some((r) => Number(r.alanyaID) !== Number(exceptUser));
  }, false);

/**
 * Fin de la quarantaine d'un numéro, ou null s'il n'y est pas.
 *
 * Seul compte le dernier départ : si c'est `exceptUser` qui l'a quitté, il
 * peut le reprendre — la quarantaine protège l'ancien titulaire, elle ne le
 * vise pas.
 */
const quarantineUntil = (canonical, { exceptUser = null, now = new Date(), conn = pool } = {}) =>
  tolerateMissingTable(async () => {
    const days = PHONE_CHANGE.quarantineDays;
    const [[last]] = await conn.execute(
      `SELECT alanyaID, changed_at FROM alanya_phone_history
        WHERE old_phone = ? AND changed_at > ?
        ORDER BY changed_at DESC, id DESC LIMIT 1`,
      [canonical, new Date(now.getTime() - days * DAY_MS)],
    );
    if (!last || Number(last.alanyaID) === Number(exceptUser)) return null;
    return new Date(new Date(last.changed_at).getTime() + days * DAY_MS);
  }, null);

const isPhoneAvailable = async (canonical) => {
  if (await phoneExists(canonical)) return false;
  if (await isReserved(canonical)) return false;
  return true;
};

/**
 * Un numéro à 8 chiffres peut-il être acheté par ce compte ?
 *
 * Tous les faits sont lus, puis `purchaseRefusal` tranche : l'ordre des refus
 * est une règle, testée sans base. Un numéro qui suit un motif réservé
 * (XXYYZZTT) se vend comme un autre ; seule la liste de l'administration le
 * met de côté.
 *
 * @returns {Promise<{ available: boolean, reason: string|null }>}
 */
const purchaseAvailability = async (canonical, {
  alanyaID, currentPhone, now = new Date(), conn = pool,
}) => {
  const reason = purchaseRefusal({
    isOwn: canonical === currentPhone,
    taken: await phoneExists(canonical, conn),
    setAside: await isInReservedTable(canonical, conn),
    heldByOther: await isHeld(canonical, { exceptUser: alanyaID, now, conn }),
    quarantined: (await quarantineUntil(canonical, { exceptUser: alanyaID, now, conn })) != null,
  });
  return { available: reason == null, reason };
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
    if (await phoneExists(candidate)) continue;
    // Le tirage ne donne ni un numéro qu'un autre est en train d'acheter, ni
    // celui qu'un autre vient de quitter.
    if (await isHeld(candidate)) continue;
    if (await quarantineUntil(candidate)) continue;
    return candidate;
  }
  throw new Error(`Impossible de générer un alanyaPhone unique (${length} ch.) après 50 tentatives`);
};

module.exports = {
  phoneExists,
  isInReservedTable,
  isReserved,
  isHeld,
  quarantineUntil,
  isPhoneAvailable,
  purchaseAvailability,
  generateUniquePhone,
};
