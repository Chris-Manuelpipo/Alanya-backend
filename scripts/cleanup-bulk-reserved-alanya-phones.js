#!/usr/bin/env node
/**
 * Nettoyage : retire les numéros réservés auto-seedés en masse
 * (created_by IS NULL). Les ajouts manuels admin (created_by renseigné) sont conservés.
 *
 * Les patterns (3 / 4 chiffres, XXYYZZTT) sont désormais gérés en code
 * via isPatternReserved — plus besoin de tout stocker en BD.
 *
 * Usage : node scripts/cleanup-bulk-reserved-alanya-phones.js
 */
const pool = require('../src/config/db');

async function main() {
  const [[{ cnt_before }]] = await pool.execute(
    'SELECT COUNT(*) AS cnt_before FROM reserved_alanya_phone'
  );

  const [result] = await pool.execute(
    'DELETE FROM reserved_alanya_phone WHERE created_by IS NULL'
  );

  const deleted = result.affectedRows || 0;
  const [[{ cnt_after }]] = await pool.execute(
    'SELECT COUNT(*) AS cnt_after FROM reserved_alanya_phone'
  );

  console.log(
    `Avant : ${cnt_before} · Supprimés (auto-seed) : ${deleted} · Restants (manuels) : ${cnt_after}`
  );
  await pool.end();
}

main().catch((err) => {
  console.error('Échec du cleanup :', err.message);
  process.exit(1);
});
