/**
 * Vérification du stockage objet — `node scripts/dev/b2-smoke.js`.
 *
 * Exerce, sur le vrai bucket, tout ce dont le serveur a besoin : déposer,
 * signer une lecture, télécharger, signer un HEAD, copier, lister, supprimer
 * toutes les versions. Aucune base de données, aucun serveur à lancer : c'est
 * le moyen de savoir si les clés, la région et le bucket sont bons AVANT de
 * brancher quoi que ce soit.
 *
 * Le fichier déposé est un objet de test sous `media/<jour>/files/`, supprimé
 * à la fin — y compris si une étape échoue.
 *
 * Lit le `.env` du dépôt. `MEDIA_STORAGE` n'a pas besoin d'être à `b2` : il
 * suffit que B2_ENDPOINT, B2_REGION, B2_BUCKET, B2_KEY_ID et B2_APP_KEY soient
 * renseignés.
 */

require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');

const storage = require('../../src/services/mediaStorage');

const OK = '✓';
const KO = '✗';

async function main() {
  const manquantes = ['B2_ENDPOINT', 'B2_REGION', 'B2_BUCKET', 'B2_KEY_ID', 'B2_APP_KEY']
    .filter((n) => !process.env[n]);
  if (manquantes.length > 0) {
    console.error(`${KO} Variables manquantes dans .env : ${manquantes.join(', ')}`);
    console.error('  Voir .env.example, section « Stockage des médias (Backblaze B2) ».');
    process.exit(1);
  }

  // Le script doit marcher même quand MEDIA_STORAGE est resté à `disk` : c'est
  // justement l'ordre recommandé (vérifier les clés avant de basculer).
  storage.configureForTests({ demande: 'b2' });

  console.log(`Bucket   : ${storage.STORAGE.bucket}`);
  console.log(`Endpoint : ${storage.STORAGE.endpoint}`);
  console.log('');

  const instant = Date.now();
  const cle = storage.newMediaKey({ kind: 'files', alanyaID: 0, ext: '.txt', instant });
  const copie = storage.newMediaKey({ kind: 'files', alanyaID: 0, ext: '.txt', instant: instant + 1 });
  const contenu = `alanya b2-smoke ${new Date(instant).toISOString()}\n`;
  const local = path.join(os.tmpdir(), `b2-smoke-${instant}.txt`);
  fs.writeFileSync(local, contenu);

  let echec = null;
  try {
    await storage.putFile(cle, local, { contentType: 'text/plain' });
    console.log(`${OK} dépôt                ${cle}`);

    const lien = await storage.presignRead(cle, 'GET');
    const rep = await fetch(lien);
    const lu = await rep.text();
    if (rep.status !== 200 || lu !== contenu) {
      throw new Error(`lecture inattendue : statut ${rep.status}, ${lu.length} octet(s)`);
    }
    console.log(`${OK} lecture signée       ${rep.status}, ${lu.length} octets`);
    console.log(`  en-tête de cache     ${rep.headers.get('cache-control') || '(absent — à signaler)'}`);
    console.log(`  type renvoyé         ${rep.headers.get('content-type') || '(absent)'}`);

    const lienHead = await storage.presignRead(cle, 'HEAD');
    const repHead = await fetch(lienHead, { method: 'HEAD' });
    if (repHead.status !== 200) throw new Error(`HEAD signé refusé : ${repHead.status}`);
    console.log(`${OK} HEAD signé           ${repHead.status}, taille ${repHead.headers.get('content-length')}`);

    await storage.copyObject(cle, copie);
    console.log(`${OK} copie (transfert)    ${copie}`);

    const dossier = `${cle.slice(0, cle.lastIndexOf('/') + 1)}`;
    const liste = await storage.listPrefix(dossier);
    console.log(`${OK} liste du dossier     ${liste.length} objet(s) sous ${dossier}`);

    const { url: lienEnvoi, headers } = await storage.presignUpload(
      storage.newMediaKey({ kind: 'files', alanyaID: 0, ext: '.txt', instant: instant + 2 }),
      { contentType: 'text/plain', contentLength: contenu.length },
    );
    const signes = new URL(lienEnvoi).searchParams.get('X-Amz-SignedHeaders');
    console.log(`${OK} lien d'envoi signé   en-têtes signés : ${signes}`);
    if (!signes.includes('content-length')) {
      console.log('  ⚠ la taille n\'est pas signée : un client pourrait envoyer plus gros que déclaré');
    }
    console.log(`  à renvoyer par l'app : ${Object.keys(headers).join(', ')}`);
  } catch (e) {
    echec = e;
    console.error(`${KO} ${e.name} : ${e.message}`);
  } finally {
    fs.unlinkSync(local);
    for (const k of [cle, copie]) {
      try {
        const n = await storage.removeAllVersions(k);
        if (n > 0) console.log(`${OK} ménage               ${k} (${n} version(s))`);
      } catch (e) {
        console.error(`${KO} ménage impossible pour ${k} : ${e.message} — à supprimer à la main`);
      }
    }
  }

  if (echec) {
    console.error('\nÉchec. Pistes : clé limitée à un autre bucket, « Allow List All Bucket Names » '
      + 'non coché, région de l\'endpoint différente de celle du compte, ou clé principale '
      + 'du compte utilisée (elle ne marche pas avec l\'API S3).');
    process.exit(1);
  }
  console.log('\nTout est bon : le serveur peut parler à ce bucket.');
}

main().catch((e) => {
  console.error(`${KO} ${e.message}`);
  process.exit(1);
});
