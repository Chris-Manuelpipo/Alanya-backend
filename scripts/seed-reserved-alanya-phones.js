#!/usr/bin/env node
/**
 * Insère tous les numéros Alanya réservés :
 * - 3 chiffres : 000–999
 * - 4 chiffres : 0000–9999
 * - 8 chiffres : positions paires égales (d0 X d0 X d0 X d0 X), inclut les chiffres identiques
 *
 * Usage : node scripts/seed-reserved-alanya-phones.js
 */
const pool = require('../src/config/db');

const BATCH_SIZE = 500;

function* generateReservedPhones() {
  for (let i = 0; i < 1000; i++) {
    yield { phone: String(i).padStart(3, '0'), label: 'Réservé (3 chiffres)' };
  }

  for (let i = 0; i < 10000; i++) {
    yield { phone: String(i).padStart(4, '0'), label: 'Réservé (4 chiffres)' };
  }

  for (let d = 0; d <= 9; d++) {
    const even = String(d);
    for (let i = 0; i < 10000; i++) {
      const odd = String(i).padStart(4, '0');
      const phone = even + odd[0] + even + odd[1] + even + odd[2] + even + odd[3];
      const allSame = odd.split('').every((ch) => ch === even);
      yield {
        phone,
        label: allSame ? 'Réservé (chiffres identiques)' : 'Réservé (pattern paire)',
      };
    }
  }
}

async function insertBatch(batch) {
  const placeholders = batch.map(() => '(?, ?)').join(', ');
  const values = batch.flatMap((row) => [row.phone, row.label]);
  await pool.execute(
    `INSERT INTO reserved_alanya_phone (phone_canonical, label)
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE label = VALUES(label)`,
    values
  );
}

async function main() {
  const buffer = [];
  let total = 0;

  console.log('Insertion des numéros réservés…');

  for (const row of generateReservedPhones()) {
    buffer.push(row);
    if (buffer.length >= BATCH_SIZE) {
      await insertBatch(buffer);
      total += buffer.length;
      process.stdout.write(`\r${total} numéros insérés…`);
      buffer.length = 0;
    }
  }

  if (buffer.length > 0) {
    await insertBatch(buffer);
    total += buffer.length;
  }

  console.log(`\nTerminé : ${total} numéros traités.`);
  await pool.end();
}

main().catch((err) => {
  console.error('Échec du seed :', err.message);
  process.exit(1);
});
