/**
 * Répartit les fichiers existants dans les buckets publics.
 *
 * Conception : docs/conception/medias-buckets.html, section 09. La logique
 * est dans src/services/publicBucketsMigration.js ; ce script ne fait que la
 * lancer et afficher le compte rendu.
 *
 * ── Avant ──
 *
 * Dans le `.env` du serveur : `MEDIA_STORAGE=b2`, et pour chacun des deux
 * buckets publics son nom, sa clé et son secret (`B2_PROFILE_*`,
 * `B2_PROFILEMEDIA_*`). Le code qui sait lire aux deux endroits doit déjà être
 * déployé.
 *
 * ── Utilisation, dans l'ordre ──
 *
 *   node scripts/maintenance/migrate-public-buckets.js              # simulation
 *   node scripts/maintenance/migrate-public-buckets.js --apply      # copie + adresses
 *
 *   puis MEDIA_PUBLIC_MIGRATED=true dans le .env, et redémarrage : les
 *   anciennes adresses `/uploads/images/…` sont alors redirigées vers le
 *   bucket public.
 *
 *   node scripts/maintenance/migrate-public-buckets.js --nettoyer-prive          # simulation
 *   node scripts/maintenance/migrate-public-buckets.js --nettoyer-prive --apply  # suppression
 *
 * Par défaut : simulation. Rien n'est copié ni écrit sans `--apply`. Chaque
 * étape est rejouable : relancer ne refait rien de ce qui est fait.
 */

const { executer } = require('../../src/services/publicBucketsMigration');
const pool = require('../../src/config/db');

const APPLY = process.argv.includes('--apply');
const NETTOYER = process.argv.includes('--nettoyer-prive');

const ligne = (etiquette, valeur) => console.log(`  ${etiquette.padEnd(38, '.')} ${valeur}`);

(async () => {
  console.log(APPLY ? 'APPLICATION\n' : 'SIMULATION — rien ne sera écrit.\n');
  try {
    const res = await executer({ appliquer: APPLY, nettoyer: NETTOYER });

    if (NETTOYER) {
      console.log('Nettoyage du bucket privé');
      ligne('à supprimer (copie publique vérifiée)', res.nettoyage.aSupprimer);
      ligne('supprimés', res.nettoyage.supprimes);
      ligne('gardés (pas de copie publique)', res.nettoyage.gardes);
    } else {
      console.log('1. Copie vers les buckets publics');
      ligne('déjà présents', res.copie.dejaLa);
      ligne('à copier', res.copie.aCopier);
      ligne('copiés', res.copie.copies);
      ligne('échecs', res.copie.echecs);
      console.log('\n2. Médias officiels (diffusions, accueil)');
      ligne('adresses à réécrire', res.officiels.adresses);
      ligne('fichiers à copier', res.officiels.aCopier);
      ligne('copiés', res.officiels.copies);
      ligne('introuvables (déjà expirés)', res.officiels.introuvables);
      ligne('échecs', res.officiels.echecs);
      console.log('\n3. Adresses des photos et des annonces');
      ligne('à réécrire', res.adresses.aReecrire);
      ligne('réécrites', res.adresses.reecrites);
      ligne('fichier absent, adresse gardée', res.adresses.fichierAbsent);

      if (APPLY) {
        console.log('\nÉtape suivante : MEDIA_PUBLIC_MIGRATED=true dans le .env, puis redémarrer.');
        console.log('Pensez aussi à passer AVATAR_DEFAULT_MALE et AVATAR_DEFAULT_FEMALE sur leur');
        console.log('adresse publique (alanyaprofile) : les anciennes restent servies par redirection.');
      }
    }
    if (!APPLY) console.log('\nSIMULATION — rien n\'a été écrit. Relancer avec --apply pour appliquer.');
  } catch (e) {
    console.error(`\nÉchec : ${e.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
})();
