const pool = require('../config/db');
const { ACCOUNT_TYPE } = require('../constants/accountTypes');

/**
 * Le compte officiel est unique : son identifiant tient donc en mémoire de
 * processus, et les gardes qui l'invoquent — ajout à une conversation, appel,
 * blocage, connexion — deviennent une comparaison d'entiers plutôt qu'une
 * requête. `canAddUser` est appelé une fois par membre à la création d'un
 * groupe : une requête par appel s'y verrait.
 *
 * Le cache retient aussi l'absence de compte officiel, sinon chaque garde
 * interrogerait la base tant qu'il n'existe pas — c'est-à-dire tout le temps
 * avant sa création.
 */
const TTL_MS = 60_000;

let cachedId = null;
let loadedAt = 0;

const invalidateOfficialAccountCache = () => {
  loadedAt = 0;
  cachedId = null;
};

/**
 * @returns {Promise<number|null>} l'identifiant du compte officiel, ou null.
 */
const getOfficialAccountId = async () => {
  if (loadedAt && Date.now() - loadedAt < TTL_MS) return cachedId;
  try {
    const [rows] = await pool.execute(
      'SELECT alanyaID FROM users WHERE account_type = ? ORDER BY alanyaID ASC LIMIT 1',
      [ACCOUNT_TYPE.OFFICIEL],
    );
    cachedId = rows.length ? Number(rows[0].alanyaID) : null;
    loadedAt = Date.now();
  } catch (e) {
    // Colonne absente avant migration : aucun compte officiel, aucun garde.
    if (e.code !== 'ER_BAD_FIELD_ERROR' && e.code !== 'ER_NO_SUCH_TABLE') throw e;
    cachedId = null;
    loadedAt = Date.now();
  }
  return cachedId;
};

/**
 * @param {number|string} alanyaID
 * @returns {Promise<boolean>}
 */
const isOfficialAccount = async (alanyaID) => {
  if (alanyaID == null) return false;
  const officialId = await getOfficialAccountId();
  return officialId != null && Number(alanyaID) === officialId;
};

module.exports = {
  getOfficialAccountId,
  isOfficialAccount,
  invalidateOfficialAccountCache,
};
