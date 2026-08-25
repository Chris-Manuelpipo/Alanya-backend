/**
 * Reconstruction des `message.mediaUrl` effacés par erreur le 2026-08-25.
 *
 * Contexte : la purge des médias a vidé 707 `mediaUrl` alors que les fichiers
 * correspondants sont toujours sur le disque du serveur. Ce script recolle
 * les deux, en s'appuyant sur la convention de nommage des uploads :
 *
 *     uploads/media/<sous-dossier>/media_<alanyaID>_<epochMs>.<ext>
 *
 * Le rapprochement est fiable parce qu'il croise deux informations
 * indépendantes : l'identifiant de l'expéditeur, présent dans le nom du
 * fichier ET dans le message, et l'instant de l'upload, qui précède la
 * création du message de 1 à 6 secondes (vérifié sur les 206 paires
 * intactes). Une fenêtre de 120 s en amont couvre largement, y compris un
 * upload lent, sans risquer d'attraper l'envoi suivant.
 *
 * Règle de prudence : un fichier ne peut être attribué qu'à UN message, et un
 * message n'est restauré que si exactement un fichier candidat subsiste.
 * Toute ambiguïté est laissée de côté et signalée — mieux vaut un média
 * manquant qu'un média attribué au mauvais message, dans le mauvais fil.
 *
 * Par défaut : simulation. Rien n'est écrit sans --apply.
 *
 *   node scripts/maintenance/restore-media-urls.js            # simulation
 *   node scripts/maintenance/restore-media-urls.js --apply    # écriture
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../../src/config/db');

const APPLY = process.argv.includes('--apply');
const RACINE = path.join(__dirname, '../../uploads');
const BASE_URL = process.env.MEDIA_BASE_URL || 'https://www.alanya237.com';

// Fenêtre autour de sendAt dans laquelle l'upload a forcément eu lieu.
const AVANT_MS = 120 * 1000;
const APRES_MS = 10 * 1000;

/** Inventorie les fichiers `media_<id>_<ts>.<ext>` sous uploads/. */
function inventorier(dir, acc = []) {
  let entrees;
  try { entrees = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entrees) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { inventorier(p, acc); continue; }
    const m = e.name.match(/^media_(\d+)_(\d+)\.(.+)$/);
    if (!m) continue;
    acc.push({
      chemin: path.relative(RACINE, p).split(path.sep).join('/'),
      alanyaID: Number(m[1]),
      ts: Number(m[2]),
      pris: false,
    });
  }
  return acc;
}

(async () => {
  const fichiers = inventorier(RACINE);
  console.log(`Fichiers « media_ » trouvés sur le disque : ${fichiers.length}`);
  if (!fichiers.length) {
    console.error(
      'Aucun fichier inventorié — ce script doit tourner SUR LE SERVEUR, '
      + `depuis la racine du backend (uploads/ attendu ici : ${RACINE}).`,
    );
    process.exit(1);
  }

  // Index par expéditeur, trié par instant d'upload.
  const parExpediteur = new Map();
  for (const f of fichiers) {
    if (!parExpediteur.has(f.alanyaID)) parExpediteur.set(f.alanyaID, []);
    parExpediteur.get(f.alanyaID).push(f);
  }
  for (const liste of parExpediteur.values()) liste.sort((a, b) => a.ts - b.ts);

  // Les URL encore en place : leurs fichiers sont déjà attribués, ils ne
  // doivent pas être proposés à un autre message.
  const [intacts] = await pool.execute(
    "SELECT mediaUrl FROM message WHERE mediaUrl IS NOT NULL AND mediaUrl <> ''",
  );
  const dejaPris = new Set(
    intacts.map((r) => String(r.mediaUrl).split('/uploads/')[1]).filter(Boolean),
  );
  for (const f of fichiers) if (dejaPris.has(f.chemin)) f.pris = true;
  console.log(`Fichiers déjà référencés par un message intact : ${dejaPris.size}`);

  // Messages à restaurer. `isViewOnce = 1` est exclu : ces médias ont été
  // vidés légitimement après consultation, les remettre ressusciterait un
  // contenu que l'expéditeur voulait éphémère.
  const [cibles] = await pool.execute(`
    SELECT msgID, senderID, UNIX_TIMESTAMP(sendAt) * 1000 AS envoiMs, mediaName, type
      FROM message
     WHERE mediaUrl IS NULL
       AND sendAt < DATE_SUB(NOW(), INTERVAL 30 DAY)
       AND (mediaName IS NOT NULL OR mediaDuration IS NOT NULL)
       AND (isViewOnce IS NULL OR isViewOnce = 0)
     ORDER BY msgID ASC`);
  console.log(`Messages à restaurer : ${cibles.length}\n`);

  const retenus = [];
  const ambigus = [];
  const introuvables = [];

  for (const msg of cibles) {
    const candidats = (parExpediteur.get(msg.senderID) || []).filter(
      (f) => !f.pris && f.ts >= msg.envoiMs - AVANT_MS && f.ts <= msg.envoiMs + APRES_MS,
    );
    if (candidats.length === 1) {
      candidats[0].pris = true;
      retenus.push({ msgID: msg.msgID, url: `${BASE_URL}/uploads/${candidats[0].chemin}` });
    } else if (candidats.length > 1) {
      ambigus.push({ msgID: msg.msgID, n: candidats.length });
    } else {
      introuvables.push(msg.msgID);
    }
  }

  console.log('── Résultat du rapprochement ──');
  console.log(`  restaurables (1 seul fichier candidat) : ${retenus.length}`);
  console.log(`  ambigus (plusieurs candidats, ignorés) : ${ambigus.length}`);
  console.log(`  sans fichier correspondant             : ${introuvables.length}`);
  if (retenus.length) {
    console.log('\n  échantillon :');
    for (const r of retenus.slice(0, 5)) console.log(`    msg ${r.msgID} → ${r.url}`);
  }
  if (ambigus.length) {
    console.log(`\n  ambigus : ${ambigus.slice(0, 10).map((a) => a.msgID).join(', ')}${ambigus.length > 10 ? '…' : ''}`);
  }

  if (!APPLY) {
    console.log('\nSIMULATION — rien n\'a été écrit. Relancer avec --apply pour appliquer.');
    await pool.end();
    return;
  }

  let ecrits = 0;
  for (const r of retenus) {
    const [res] = await pool.execute(
      // La garde `mediaUrl IS NULL` rend le script rejouable sans risque :
      // un message déjà restauré (par une exécution précédente) est ignoré.
      'UPDATE message SET mediaUrl = ? WHERE msgID = ? AND mediaUrl IS NULL',
      [r.url, r.msgID],
    );
    ecrits += res.affectedRows || 0;
  }
  console.log(`\nAppliqué : ${ecrits} mediaUrl restaurés.`);
  await pool.end();
})().catch((e) => {
  console.error('ÉCHEC:', e);
  process.exit(1);
});
