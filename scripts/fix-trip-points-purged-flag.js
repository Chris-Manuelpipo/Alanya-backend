#!/usr/bin/env node
/**
 * Réparation ponctuelle : `trip.points_purged_at` posé à tort.
 *
 * Le balayage nocturne marquait « trace purgée » TOUS les trajets clos sans
 * horodatage dès qu'un seul point avait été supprimé dans la nuit — y compris
 * des trajets clos la veille dont les positions étaient toujours en base.
 * L'application affichait alors « Trace expirée » sur un trajet parfaitement
 * rejouable. La purge ne marque plus que ce qu'elle efface ; ce script remet
 * d'équerre les lignes déjà abîmées.
 *
 * Sans effet sur les vraies purges : un trajet dont les points sont réellement
 * partis n'a plus de ligne dans `trip_point` et garde son horodatage.
 *
 * Usage : node scripts/fix-trip-points-purged-flag.js [--dry-run]
 */
const pool = require('../src/config/db');

const DRY_RUN = process.argv.includes('--dry-run');

const CIBLE = `
  FROM trip t
 WHERE t.points_purged_at IS NOT NULL
   AND EXISTS (SELECT 1 FROM trip_point p WHERE p.trip_id = t.id)`;

async function main() {
  const [[{ cnt }]] = await pool.execute(`SELECT COUNT(*) AS cnt ${CIBLE}`);

  if (!cnt) {
    console.log('Aucun trajet mal marqué. Rien à faire.');
    return;
  }

  console.log(`${cnt} trajet(s) marqués « purgés » alors que leurs positions sont là.`);

  if (DRY_RUN) {
    console.log('--dry-run : aucune écriture.');
    return;
  }

  const [res] = await pool.execute(
    `UPDATE trip t SET t.points_purged_at = NULL
      WHERE t.points_purged_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM trip_point p WHERE p.trip_id = t.id)`,
  );
  console.log(`${res.affectedRows} trajet(s) rétablis — leur trace redevient consultable.`);
}

main()
  .catch((e) => {
    console.error('Échec :', e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
