/**
 * Copie les médias de discussion du bucket privé de Backblaze vers celui de
 * Cloudflare R2.
 *
 * La logique est dans src/services/privateBucketMigration.js ; ce script ne
 * fait que la lancer et afficher le compte rendu.
 *
 * ── Avant ──
 *
 * Dans le `.env` : `R2_ENDPOINT`, `R2_BUCKET`, `R2_KEY_ID`, `R2_APP_KEY`, et
 * toujours les réglages du bucket privé de Backblaze (`B2_ENDPOINT`,
 * `B2_REGION`, `B2_BUCKET`, `B2_KEY_ID`, `B2_APP_KEY`). Le serveur doit avoir
 * redémarré avec ces réglages depuis au moins vingt minutes : un lien d'envoi
 * vers Backblaze donné juste avant reste valable un quart d'heure.
 *
 * ── Utilisation, dans l'ordre ──
 *
 *   node scripts/maintenance/migrate-private-to-r2.js              # simulation
 *   node scripts/maintenance/migrate-private-to-r2.js --apply      # copie
 *
 *   puis MEDIA_PRIVATE_MIGRATED=true dans le .env, et redémarrage : l'ancien
 *   bucket n'est alors plus consulté.
 *
 * Par défaut : simulation. Rien n'est copié sans `--apply`. Rejouable :
 * relancer ne recopie que ce qui manque. Rien n'est supprimé chez Backblaze.
 */

require('dotenv').config({ quiet: true });

const { executer } = require('../../src/services/privateBucketMigration');

const APPLY = process.argv.includes('--apply');

const ligne = (etiquette, valeur) => console.log(`  ${etiquette.padEnd(38, '.')} ${valeur}`);
const enMo = (octets) => `${(octets / 1e6).toFixed(1)} Mo`;

(async () => {
  console.log(APPLY ? 'APPLICATION\n' : 'SIMULATION — rien ne sera écrit.\n');
  try {
    const res = await executer({ appliquer: APPLY });
    console.log('Copie de Backblaze vers R2 (media/)');
    ligne('médias chez Backblaze', res.sources);
    ligne('déjà chez R2', res.dejaLa);
    ligne('à copier', `${res.aCopier} (${enMo(res.octets)})`);
    ligne('copiés', res.copies);
    ligne('échecs', res.echecs);

    if (!APPLY) {
      console.log('\nSIMULATION — rien n\'a été écrit. Relancer avec --apply pour appliquer.');
    } else if (res.manquants > 0) {
      ligne('encore absents de R2', res.manquants);
      console.log('\nIncomplet : relancer avec --apply. Ne pas poser MEDIA_PRIVATE_MIGRATED.');
      process.exitCode = 1;
    } else {
      console.log('\nTout est chez R2. Étape suivante : MEDIA_PRIVATE_MIGRATED=true dans le .env, puis redémarrer.');
    }
  } catch (e) {
    console.error(`\nÉchec : ${e.message}`);
    process.exitCode = 1;
  }
})();
