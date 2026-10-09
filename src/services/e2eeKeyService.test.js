/**
 * Annuaire des clés : retrait à la révocation, seuil de regarnissage.
 *
 * Faux pool injecté dans `require.cache` avant le chargement du service. Le
 * retrait est appelé par les trois chemins qui révoquent un appareil : il ne
 * doit JAMAIS faire échouer une révocation, y compris sur une base où la
 * migration 091 n'a pas été jouée.
 */
const assert = require('assert');

const dbPath = require.resolve('../config/db');
let requetes = [];
/** Erreur que lèvera la prochaine requête, le cas échéant. */
let echec = null;
const fakePool = {
  execute: async (sql, params) => {
    requetes.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (echec) throw echec;
    return [{ affectedRows: params.length }, []];
  },
};
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: fakePool, paths: [], children: [],
};

const {
  SEUIL_REGARNISSAGE,
  etatDuStock,
  retireClesAppareils,
} = require('./e2eeKeyService');

async function main() {
  /* ── Retrait nominal : le stock d'abord, puis le bundle ── */
  requetes = [];
  echec = null;
  assert.strictEqual(await retireClesAppareils([12, '13', 12, 0, 'x']), 2);
  assert.strictEqual(requetes.length, 2);
  assert.match(requetes[0].sql, /^DELETE FROM e2ee_one_time_prekeys WHERE appareil_id IN \(\?,\?\)$/);
  assert.match(requetes[1].sql, /^DELETE FROM e2ee_device_keys WHERE appareil_id IN \(\?,\?\)$/);
  assert.deepStrictEqual(requetes[1].params, [12, 13], 'identifiants dédoublonnés, invalides écartés');

  /* ── Rien à retirer : aucune requête ── */
  requetes = [];
  assert.strictEqual(await retireClesAppareils([]), 0);
  assert.strictEqual(await retireClesAppareils(null), 0);
  assert.strictEqual(requetes.length, 0);

  /* ── Table absente : silencieux, et ne lève pas ── */
  const absente = new Error("Table 'e2ee_one_time_prekeys' doesn't exist");
  absente.code = 'ER_NO_SUCH_TABLE';
  echec = absente;
  const avertissements = [];
  const warn = console.warn;
  console.warn = (...a) => avertissements.push(a.join(' '));
  try {
    assert.strictEqual(await retireClesAppareils([12]), 0, 'migration absente : la révocation passe');
    assert.strictEqual(avertissements.length, 0, 'une table absente n\'est pas une anomalie');

    /* ── Autre panne : journalisée, et ne lève toujours pas ── */
    const panne = new Error('Connection lost');
    panne.code = 'PROTOCOL_CONNECTION_LOST';
    echec = panne;
    assert.strictEqual(await retireClesAppareils([12]), 0);
    assert.strictEqual(avertissements.length, 1, 'une vraie panne laisse une trace');
  } finally {
    console.warn = warn;
    echec = null;
  }

  /* ── Seuil de regarnissage : c'est le serveur qui réclame ── */
  assert.strictEqual(etatDuStock(SEUIL_REGARNISSAGE - 1).regarnissageNecessaire, true);
  assert.strictEqual(etatDuStock(SEUIL_REGARNISSAGE).regarnissageNecessaire, false, 'témoin : au seuil, rien à faire');
  assert.strictEqual(etatDuStock(0).seuil, SEUIL_REGARNISSAGE);

  console.log('e2eeKeyService.test.js OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
