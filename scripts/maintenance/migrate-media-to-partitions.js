/**
 * Range les médias existants en partitions de 24 heures.
 *
 * Fait passer la disposition historique
 *
 *     uploads/media/<sous-dossier>/media_<alanyaID>_<epochMs>.<ext>
 *
 * à la disposition partitionnée
 *
 *     uploads/media/<AAAA-MM-JJ>/<sous-dossier>/media_<alanyaID>_<epochMs>.<ext>
 *
 * où le jour est celui de l'upload, lu dans le nom du fichier. C'est ce qui
 * rend l'opération **déterministe et rejouable** : la partition d'un fichier
 * ne dépend ni de la base, ni de l'ordre de traitement, ni de l'instant où le
 * script tourne. Deux exécutions donnent le même résultat.
 *
 * ── Ce que le script NE fait PAS ──
 *
 * Il ne touche pas à `message.mediaUrl`. Les adresses déjà en base continuent
 * de pointer vers l'ancien chemin, et c'est délibéré : le relais de lecture
 * (`middleware/mediaExpiry.js`) recalcule la partition depuis le nom du
 * fichier et sert le contenu. On évite ainsi un `UPDATE` de masse sur la table
 * la plus chaude de la base, sans fenêtre de migration et sans rien à annuler
 * en cas de retour arrière. Les anciennes URL meurent d'elles-mêmes au terme
 * de la rétention, après quoi le relais se retire.
 *
 * Il ne touche pas non plus aux avatars (`uploads/images/`), qui n'expirent
 * jamais, ni aux fichiers déjà partitionnés, ni au sas `.trash`.
 *
 * ── Ordre de mise en service ──
 *
 * Ce script doit tourner AVANT d'activer `MEDIA_PARTITIONS_ENABLED`. Dans
 * l'autre sens, les fichiers restés à l'ancienne place n'appartiendraient à
 * aucune partition : ils ne seraient jamais supprimés, et l'on recréerait
 * exactement la poche d'orphelins que ce chantier existe pour éliminer.
 *
 * ── Utilisation ──
 *
 *   node scripts/maintenance/migrate-media-to-partitions.js            # simulation
 *   node scripts/maintenance/migrate-media-to-partitions.js --apply    # déplacement
 *   node scripts/maintenance/migrate-media-to-partitions.js --mtime    # inclut les
 *                                                                     # noms hors convention
 *
 * Par défaut : simulation. Rien n'est déplacé sans `--apply`.
 */

const fs = require('fs');
const path = require('path');

const {
  MEDIA_ROOT,
  LEGACY_KINDS,
  isPartitionKey,
  isPartitionExpired,
  partitionKeyFor,
  uploadMsFromFileName,
} = require('../../src/utils/mediaPartition');
const { RETENTION, PARTITIONS } = require('../../src/constants/mediaRetentionPolicy');

const APPLY = process.argv.includes('--apply');
// Les fichiers dont le nom ne suit pas la convention n'ont pas d'horodatage
// fiable. Par défaut on les LAISSE en place et on les signale, plutôt que de
// leur inventer une date : `mtime` est réécrit par un `rsync`, un `cp -a` ou
// une restauration de sauvegarde, et se tromper de partition, c'est supprimer
// un fichier trop tôt — ou ne jamais le supprimer.
const MTIME = process.argv.includes('--mtime');

const RACINE = path.join(__dirname, '../../uploads');
const MEDIA_DIR = path.join(RACINE, MEDIA_ROOT);

const RETENTION_JOURS = RETENTION.mediaDays;
const MAINTENANT = Date.now();

const mo = (octets) => `${(octets / 1024 / 1024).toFixed(1)} Mo`;

/**
 * Inventorie les fichiers restés dans la disposition historique.
 *
 * On ne descend QUE dans les quatre sous-dossiers connus. Un `readdir` de
 * `uploads/media/` renvoie aussi les partitions déjà créées : les confondre
 * ferait re-déplacer des fichiers déjà rangés, à une date recalculée depuis
 * un nom qu'ils portent toujours — inoffensif, mais le script doit être clair
 * sur ce qu'il regarde.
 */
function inventorierHerite() {
  const trouves = [];
  for (const kind of LEGACY_KINDS) {
    const dir = path.join(MEDIA_DIR, kind);
    let entrees;
    try {
      entrees = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // sous-dossier absent : rien à migrer pour ce type
    }
    for (const e of entrees) {
      if (!e.isFile()) continue;
      const complet = path.join(dir, e.name);
      let taille = 0;
      try {
        taille = fs.statSync(complet).size;
      } catch {
        continue; // disparu entre le readdir et le stat
      }
      trouves.push({ kind, nom: e.name, chemin: complet, taille });
    }
  }
  return trouves;
}

/** Instant d'upload d'un fichier, et la façon dont il a été obtenu. */
function dater(fichier) {
  const parNom = uploadMsFromFileName(fichier.nom);
  if (parNom !== null) return { ms: parNom, source: 'nom' };
  if (!MTIME) return null;
  try {
    return { ms: fs.statSync(fichier.chemin).mtimeMs, source: 'mtime' };
  } catch {
    return null;
  }
}

function main() {
  if (!fs.existsSync(MEDIA_DIR)) {
    console.error(
      `Dossier introuvable : ${MEDIA_DIR}\n`
      + 'Ce script doit tourner SUR LE SERVEUR, depuis la racine du backend.',
    );
    process.exit(1);
  }

  const fichiers = inventorierHerite();
  console.log(`Fichiers en disposition historique : ${fichiers.length}`);

  if (!fichiers.length) {
    console.log('\nRien à migrer — les médias sont déjà rangés en partitions.');
    return;
  }

  const plan = [];
  const sansDate = [];
  const collisions = [];
  const parPartition = new Map();
  let octetsPlan = 0;
  let parMtime = 0;

  for (const f of fichiers) {
    const date = dater(f);
    if (!date) { sansDate.push(f); continue; }
    if (date.source === 'mtime') parMtime += 1;

    const cle = partitionKeyFor(date.ms);
    if (!isPartitionKey(cle)) { sansDate.push(f); continue; }

    const destinationDir = path.join(MEDIA_DIR, cle, f.kind);
    const destination = path.join(destinationDir, f.nom);

    // Une destination déjà occupée signale soit une exécution précédente
    // interrompue, soit deux fichiers homonymes. On ne l'écrase jamais : le
    // cas est listé pour examen humain.
    if (fs.existsSync(destination)) { collisions.push({ ...f, destination }); continue; }

    plan.push({ ...f, cle, destinationDir, destination });
    octetsPlan += f.taille;
    const stat = parPartition.get(cle) || { fichiers: 0, octets: 0 };
    stat.fichiers += 1;
    stat.octets += f.taille;
    parPartition.set(cle, stat);
  }

  // ── Ce que le premier balayage supprimera ──
  //
  // La plupart de ces fichiers sont anciens : ils atterrissent dans des
  // partitions déjà échues et tomberont au premier balayage. C'est le
  // comportement voulu — il faut simplement le voir AVANT, pas le découvrir
  // après.
  let echues = 0;
  let fichiersEchus = 0;
  let octetsEchus = 0;
  for (const [cle, stat] of parPartition) {
    if (isPartitionExpired(cle, { retentionDays: RETENTION_JOURS, now: MAINTENANT })) {
      echues += 1;
      fichiersEchus += stat.fichiers;
      octetsEchus += stat.octets;
    }
  }

  const cles = [...parPartition.keys()].sort();
  console.log('\n── Plan de rangement ──');
  console.log(`  fichiers à déplacer : ${plan.length} (${mo(octetsPlan)})`);
  console.log(`  partitions créées   : ${parPartition.size}`);
  if (cles.length) {
    console.log(`  de ${cles[0]} à ${cles[cles.length - 1]}`);
  }
  if (parMtime) {
    console.log(`  datés par mtime (nom hors convention) : ${parMtime}`);
  }

  if (cles.length) {
    console.log('\n  répartition (10 plus grosses) :');
    const top = [...parPartition.entries()]
      .sort((a, b) => b[1].octets - a[1].octets)
      .slice(0, 10);
    for (const [cle, stat] of top) {
      const marque = isPartitionExpired(cle, { retentionDays: RETENTION_JOURS, now: MAINTENANT })
        ? ' ← échue' : '';
      console.log(`    ${cle}  ${String(stat.fichiers).padStart(5)} fichiers  ${mo(stat.octets).padStart(10)}${marque}`);
    }
  }

  console.log('\n── Effet du premier balayage ──');
  console.log(`  partitions déjà échues : ${echues} / ${parPartition.size}`);
  console.log(`  fichiers qui tomberont : ${fichiersEchus} (${mo(octetsEchus)})`);
  console.log(`  rétention appliquée    : ${RETENTION_JOURS} jours`);
  console.log(`  cran d'arrêt du balayage : ${PARTITIONS.maxDropsPerRun} partitions par exécution`);
  if (echues > PARTITIONS.maxDropsPerRun) {
    console.log(
      `\n  ⚠ ${echues} partitions échues pour un seuil de ${PARTITIONS.maxDropsPerRun} :`
      + ' le balayage REFUSERA ce lot.'
      + '\n    C\'est son rôle — il protège d\'un saut d\'horloge qui rendrait tout échu d\'un'
      + '\n    coup. Ce rattrapage devra donc être déclenché explicitement, ou le seuil relevé'
      + '\n    via MEDIA_PARTITIONS_MAX_DROPS.',
    );
  } else if (echues > 0) {
    console.log('  → le premier balayage passera sans buter sur le cran d\'arrêt.');
  }

  if (sansDate.length) {
    console.log(`\n  ⚠ ${sansDate.length} fichier(s) sans horodatage exploitable, LAISSÉS EN PLACE :`);
    for (const f of sansDate.slice(0, 10)) console.log(`    ${f.kind}/${f.nom}`);
    if (sansDate.length > 10) console.log(`    … et ${sansDate.length - 10} autre(s)`);
    console.log(
      '    Ils n\'appartiendront à aucune partition, donc ne seront jamais supprimés.'
      + '\n    Relancer avec --mtime pour les dater par leur date de modification.',
    );
  }

  if (collisions.length) {
    console.log(`\n  ⚠ ${collisions.length} destination(s) déjà occupée(s), IGNORÉE(S) :`);
    for (const f of collisions.slice(0, 10)) console.log(`    ${f.kind}/${f.nom}`);
    console.log('    Exécution précédente interrompue, ou fichiers homonymes. À examiner.');
  }

  if (!APPLY) {
    console.log('\nSIMULATION — rien n\'a été déplacé. Relancer avec --apply pour appliquer.');
    return;
  }

  // ── Déplacement ──
  //
  // `rename` à l'intérieur du même système de fichiers : instantané, quel que
  // soit le volume, et atomique. Un fichier est soit à l'ancienne adresse,
  // soit à la nouvelle, jamais entre les deux — une requête HTTP concurrente
  // ne peut donc jamais lire un fichier tronqué.
  let deplaces = 0;
  let echecs = 0;
  const dossiersCrees = new Set();

  for (const f of plan) {
    try {
      if (!dossiersCrees.has(f.destinationDir)) {
        fs.mkdirSync(f.destinationDir, { recursive: true });
        dossiersCrees.add(f.destinationDir);
      }
      fs.renameSync(f.chemin, f.destination);
      deplaces += 1;
    } catch (e) {
      echecs += 1;
      console.error(`  ✖ ${f.kind}/${f.nom} : ${e.message}`);
    }
  }

  console.log(`\n── Terminé ──`);
  console.log(`  déplacés : ${deplaces}`);
  if (echecs) console.log(`  échecs   : ${echecs}`);
  console.log(
    '\nLes adresses en base n\'ont pas été touchées : le relais de lecture'
    + '\nsert les anciennes URL en recalculant la partition depuis le nom du fichier.'
    + '\n\nProchaine étape : activer MEDIA_PARTITIONS_ENABLED, puis redémarrer.',
  );
}

main();
