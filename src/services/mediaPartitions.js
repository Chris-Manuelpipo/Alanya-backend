/**
 * Balayage des partitions de médias — effets sur le disque.
 *
 * Le principe est dans `utils/mediaPartition.js` : le chemin d'un média encode
 * le jour de son upload, donc supprimer les médias échus revient à supprimer un
 * répertoire. Ce module fait les trois gestes correspondants — réclamer,
 * effacer, adopter — et rien d'autre : il ne consulte jamais la base.
 *
 * ── Pourquoi `rename` et pas un verrou ──
 *
 * `rename(2)` est atomique au niveau du noyau. Si deux instances décident en
 * même temps que la partition du 20 juillet doit tomber, exactement une réussit
 * et l'autre reçoit `ENOENT` — qui se lit « quelqu'un d'autre l'a prise », pas
 * « erreur ». La destination portant l'identifiant du worker et celui de
 * l'exécution, deux instances ne peuvent jamais viser le même répertoire.
 *
 * **Le balayage est donc correct même sans aucun verrou**, et c'est la
 * propriété qui compte : un mécanisme qui ne dépend pas du verrou survit à la
 * panne du verrou. Le bail que pose l'appelant (`withLease`) ne sert qu'au
 * confort — éviter que quatre instances fassent le même `readdir` au même
 * instant, et garder des journaux lisibles. Si son TTL expire en plein
 * effacement, rien ne casse : les noms uniques suffisent déjà à isoler chaque
 * instance.
 *
 * ── Deux règles non négociables ──
 *
 * 1. La décision se prend sur le **nom du répertoire**, jamais sur `mtime` —
 *    qu'un `rsync`, un `cp -a` ou une restauration de sauvegarde réécrivent
 *    sans prévenir.
 * 2. Un **cran d'arrêt** borne le nombre de partitions supprimées par
 *    exécution (`PARTITIONS.maxDropsPerRun`). Le balayage décide à partir de
 *    l'horloge : un saut NTP de plusieurs mois rendrait toutes les partitions
 *    échues d'un coup et raserait la totalité des médias. Au-delà du seuil il
 *    refuse d'agir et le signale.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { PARTITIONS, RETENTION } = require('../constants/mediaRetentionPolicy');
const {
  MEDIA_ROOT,
  TRASH_DIR,
  LEGACY_KINDS,
  isPartitionKey,
  isPartitionExpired,
  partitionExpiresAtMs,
  partitionDirFor,
  trashNameFor,
  parseTrashName,
  sanitizeIdPart,
} = require('../utils/mediaPartition');

/**
 * Identifiant de cette instance, composé ici plutôt qu'emprunté à
 * `schedulerLease` : ce module ne consulte jamais la base, et importer le
 * `WORKER_ID` du service de baux ferait entrer le pool MySQL dans ses
 * dépendances par la bande. Un module qui ne parle qu'au système de fichiers
 * doit pouvoir être chargé — et testé — sans base de données.
 */
const WORKER_ID = sanitizeIdPart(
  `${process.env.HOSTNAME || 'local'}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`,
);

/** Un segment de chemin sûr : ni séparateur, ni remontée, ni caractère exotique. */
const SEGMENT_SUR = /^[A-Za-z0-9._-]+$/;

const UPLOADS_DIR = path.join(__dirname, '../../uploads');
const MEDIA_DIR = path.join(UPLOADS_DIR, MEDIA_ROOT);
const TRASH_PATH = path.join(UPLOADS_DIR, TRASH_DIR);

/**
 * Emplacements dérivés d'une racine.
 *
 * Toutes les fonctions acceptent une option `root` qui vaut par défaut le
 * `uploads/` du dépôt. C'est le seul moyen de tester des gestes destructeurs —
 * `rename` puis `rm -rf` sur des arborescences entières — sans les exercer sur
 * les fichiers réels du serveur.
 */
const emplacements = (root = UPLOADS_DIR) => ({
  media: path.join(root, MEDIA_ROOT),
  trash: path.join(root, TRASH_DIR),
});

/** `ENOENT` n'est pas une erreur ici : la cible a déjà disparu, le but est atteint. */
const ignorerAbsent = (e) => {
  if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
  throw e;
};

// ── Écriture : où déposer un nouvel upload ─────────────────────────────────

/**
 * Répertoires déjà créés, pour éviter un appel système par upload.
 * Le jeu de clés vivantes ne dépasse jamais quelques dizaines d'entrées (une
 * par jour et par type), il n'y a donc rien à évincer.
 */
const dossiersConnus = new Set();

/**
 * Répertoire absolu où multer doit déposer un média, et son chemin relatif à
 * `uploads/` — ce dernier sert à composer l'URL publique.
 *
 * Synchrone parce que le `destination` de multer l'est. Quand l'interrupteur
 * est éteint, rend la disposition historique : le code peut être déployé sans
 * rien changer au comportement.
 */
function resolveUploadDirSync(kind, { instant = Date.now(), root = UPLOADS_DIR } = {}) {
  const relatif = PARTITIONS.enabled
    ? partitionDirFor(kind, instant)
    : `${MEDIA_ROOT}/${kind}`;

  // `partitionDirFor` ne rend `null` que sur un instant non fini — impossible
  // ici, mais on ne crée jamais un répertoire au nom calculé de travers.
  const sousChemin = relatif || `${MEDIA_ROOT}/${kind}`;
  const absolu = path.join(root, sousChemin);

  if (!dossiersConnus.has(absolu)) {
    fs.mkdirSync(absolu, { recursive: true });
    dossiersConnus.add(absolu);
  }
  return { absolu, relatif: sousChemin };
}

/**
 * Donne au média d'un message transféré une adresse à lui, dans la partition
 * du jour du transfert.
 *
 * Le problème corrigé existe indépendamment des partitions, et il est
 * aujourd'hui en production : le transfert recopiait `source.mediaUrl`, donc
 * deux messages désignaient un seul fichier. La purge supprimait ce fichier au
 * terme de la rétention du message d'ORIGINE, et le transfert — parfois vieux
 * de quelques heures — pointait dans le vide, sa propre `mediaUrl` intacte. Le
 * destinataire voyait un média cassé, sans explication ni recours.
 *
 * La réparation est un **lien matériel** : une référence d'inode de plus, zéro
 * octet copié. L'original tombe avec sa partition, l'inode survit tant que le
 * transfert le référence, et l'espace n'est rendu qu'au dernier lien. La
 * sémantique devient exactement la bonne — **chaque message garantit la
 * rétention à son propre média**, sans dupliquer les données.
 *
 * Le nom du nouveau fichier suit la convention d'upload, horodatage compris :
 * la partition reste donc déductible du nom, ce dont dépendent aussi bien le
 * relais de lecture que le script de restauration.
 *
 * Renvoie le chemin public (relatif à `/uploads/`) ou `null` si le fichier
 * source est introuvable — auquel cas l'appelant conserve l'URL d'origine :
 * mieux vaut le comportement d'avant qu'un transfert refusé.
 */
function relinkForForward(mediaUrl, { alanyaID, instant = Date.now(), root = UPLOADS_DIR } = {}) {
  if (!mediaUrl) return null;

  const marqueur = '/uploads/';
  const i = String(mediaUrl).indexOf(marqueur);
  if (i === -1) return null;

  const relatifSource = String(mediaUrl).slice(i + marqueur.length).split('?')[0];
  const segments = relatifSource.split('/').filter(Boolean);
  // On ne relie que les médias de message : un avatar n'expire pas, et n'a
  // donc aucune raison d'être dupliqué.
  if (segments[0] !== MEDIA_ROOT || segments.length < 3) return null;

  // `mediaUrl` vient de la base. Elle y a été écrite par le serveur, mais un
  // chemin composé à partir d'une valeur stockée ne doit jamais être joint
  // les yeux fermés : un seul `..` ferait sortir de `uploads/`. Chaque segment
  // est donc validé, et le résultat vérifié comme étant bien sous la racine.
  if (!segments.every((seg) => SEGMENT_SUR.test(seg))) return null;

  const kind = segments[segments.length - 2];
  if (!LEGACY_KINDS.includes(kind)) return null;

  const source = path.join(root, relatifSource);
  const racineMedia = path.join(root, MEDIA_ROOT) + path.sep;
  if (!source.startsWith(racineMedia)) return null;
  if (!fs.existsSync(source)) return null;

  const ext = path.extname(segments[segments.length - 1]).toLowerCase();
  const nom = `media_${alanyaID}_${instant}${ext}`;
  const { absolu, relatif } = resolveUploadDirSync(kind, { instant, root });
  const destination = path.join(absolu, nom);

  try {
    fs.linkSync(source, destination);
  } catch (e) {
    if (e.code === 'EEXIST') {
      // Même expéditeur, même milliseconde, même extension : le lien existe
      // déjà et pointe sur le bon inode. Rien à faire.
      return `${relatif}/${nom}`;
    }
    // EXDEV (systèmes de fichiers distincts) ou refus du support : on retombe
    // sur une copie. Elle coûte des octets, mais la correction sémantique — un
    // fichier par message — vaut mieux qu'un transfert qui casse à J+30.
    try {
      fs.copyFileSync(source, destination);
    } catch (err) {
      console.error('[MediaPartitions] transfert : ni lien ni copie possible:', err.message);
      return null;
    }
  }
  return `${relatif}/${nom}`;
}

// ── Inventaire ─────────────────────────────────────────────────────────────

/** Noms des partitions présentes sur le disque, triés du plus ancien au plus récent. */
async function listPartitions({ root } = {}) {
  const { media } = emplacements(root);
  const entrees = await fsp.readdir(media, { withFileTypes: true }).catch(ignorerAbsent);
  if (!entrees) return [];
  return entrees
    .filter((e) => e.isDirectory() && isPartitionKey(e.name))
    .map((e) => e.name)
    .sort();
}

/**
 * Parcourt un répertoire et rend `{ fichiers, octets }`.
 *
 * Les octets ne comptent que les fichiers dont le compteur de liens vaut 1.
 * Un média transféré est un **lien matériel** vers le même inode depuis la
 * partition du jour du transfert : effacer l'une des deux entrées ne rend
 * aucun espace tant que l'autre existe. Compter ces octets surestimerait le
 * gain, et la métrique mentirait précisément dans le cas qu'on a introduit.
 */
async function measureDir(dir) {
  let fichiers = 0;
  let octets = 0;

  const parcourir = async (courant) => {
    const entrees = await fsp.readdir(courant, { withFileTypes: true }).catch(ignorerAbsent);
    if (!entrees) return;
    for (const e of entrees) {
      const complet = path.join(courant, e.name);
      if (e.isDirectory()) {
        await parcourir(complet);
        continue;
      }
      if (!e.isFile()) continue;
      const st = await fsp.lstat(complet).catch(ignorerAbsent);
      if (!st) continue;
      fichiers += 1;
      if (st.nlink <= 1) octets += st.size;
    }
  };

  await parcourir(dir);
  return { fichiers, octets };
}

/**
 * Ce que le prochain balayage supprimerait, avec les réglages courants.
 * Alimente l'écran super-admin des purges : on doit pouvoir voir ce qu'une
 * suppression irréversible s'apprête à faire avant de la déclencher.
 */
async function partitionStats({ retentionDays = RETENTION.mediaDays, now = Date.now(), root } = {}) {
  const { media } = emplacements(root);
  const toutes = await listPartitions({ root });
  const echues = toutes.filter((cle) => isPartitionExpired(cle, { retentionDays, now }));

  let fichiers = 0;
  let octets = 0;
  for (const cle of echues) {
    const m = await measureDir(path.join(media, cle));
    fichiers += m.fichiers;
    octets += m.octets;
  }

  const prochaine = toutes.find((cle) => !isPartitionExpired(cle, { retentionDays, now })) || null;

  return {
    actif: PARTITIONS.enabled,
    partitionsVivantes: toutes.length - echues.length,
    partitionsEchues: echues.length,
    fichiers,
    octets,
    plusAncienne: toutes[0] || null,
    prochaineChute: prochaine ? new Date(partitionExpiresAtMs(prochaine, retentionDays)) : null,
    // Le seuil est rendu avec les chiffres : un échu supérieur au cran d'arrêt
    // doit se lire à l'écran, pas se découvrir dans les journaux.
    cranArret: PARTITIONS.maxDropsPerRun,
    bloqueParCranArret: echues.length > PARTITIONS.maxDropsPerRun,
  };
}

// ── Réclamation ────────────────────────────────────────────────────────────

/**
 * Déplace les partitions échues vers le sas, et rend la liste des réclamations.
 *
 * Un seul appel système par partition : elle quitte l'espace servi
 * instantanément, et à aucun moment un répertoire à moitié vidé n'est exposé en
 * HTTP. L'effacement réel vient ensuite, hors du chemin critique.
 */
async function claimExpiredPartitions({
  retentionDays = RETENTION.mediaDays,
  now = Date.now(),
  force = false,
  root,
  runId = crypto.randomBytes(4).toString('hex'),
} = {}) {
  const { media, trash } = emplacements(root);
  const echues = (await listPartitions({ root }))
    .filter((cle) => isPartitionExpired(cle, { retentionDays, now }));

  if (echues.length === 0) return { reclamees: [], refuse: null };

  if (!force && echues.length > PARTITIONS.maxDropsPerRun) {
    // On ne supprime rien du tout, pas « les N premières » : si l'horloge a
    // sauté, les N premières sont aussi légitimes que les autres, et en
    // effacer une partie serait un dégât partiel plutôt qu'un arrêt net.
    const refus = {
      raison: 'CRAN_ARRET',
      echues: echues.length,
      seuil: PARTITIONS.maxDropsPerRun,
      partitions: echues,
    };
    console.warn(
      `[MediaPartitions] cran d'arrêt : ${echues.length} partitions échues pour un seuil de `
      + `${PARTITIONS.maxDropsPerRun}. Aucune suppression. Vérifier l'horloge du serveur, `
      + 'puis relancer avec force si le retard est réel.',
    );
    return { reclamees: [], refuse: refus };
  }

  await fsp.mkdir(trash, { recursive: true });

  const reclamees = [];
  for (const cle of echues) {
    const destination = path.join(trash, trashNameFor(cle, WORKER_ID, runId));
    try {
      await fsp.rename(path.join(media, cle), destination);
      reclamees.push({ cle, chemin: destination });
    } catch (e) {
      // ENOENT = une autre instance a réclamé la partition entre le `readdir`
      // et le `rename`. C'est le fonctionnement normal en multi-instance, pas
      // une anomalie : on passe à la suivante.
      if (e.code !== 'ENOENT') {
        console.error(`[MediaPartitions] réclamation de ${cle} échouée:`, e.message);
      }
    }
  }
  return { reclamees, refuse: null };
}

// ── Effacement ─────────────────────────────────────────────────────────────

/**
 * Vide le sas : efface ce que cette instance a réclamé, et adopte ce qu'un
 * processus mort a laissé derrière lui.
 *
 * L'adoption passe par un `rename` — le même mécanisme, appliqué récursivement.
 * Une entrée étrangère est d'abord renommée au nom de cette instance : si le
 * `rename` réussit, elle nous appartient et personne d'autre ne l'effacera ;
 * s'il échoue, quelqu'un l'a prise avant nous. Aucun verrou n'est nécessaire.
 *
 * Le délai d'adoption évite d'arracher un `rm -rf` en cours à l'instance qui
 * l'exécute légitimement.
 */
async function emptyTrash({
  adoptAfterMs = PARTITIONS.trashAdoptionMinutes * 60 * 1000,
  now = Date.now(),
  root,
  runId = crypto.randomBytes(4).toString('hex'),
} = {}) {
  const { trash } = emplacements(root);
  const entrees = await fsp.readdir(trash, { withFileTypes: true }).catch(ignorerAbsent);
  if (!entrees) return { partitions: 0, fichiers: 0, octets: 0, adoptees: 0 };

  let partitions = 0;
  let fichiers = 0;
  let octets = 0;
  let adoptees = 0;

  for (const e of entrees) {
    if (!e.isDirectory()) continue;
    const lu = parseTrashName(e.name);
    if (!lu) continue; // nom inattendu : on n'y touche pas

    let cible = path.join(trash, e.name);

    if (lu.workerId !== WORKER_ID) {
      const st = await fsp.lstat(cible).catch(ignorerAbsent);
      if (!st) continue;
      if (now - st.mtimeMs < adoptAfterMs) continue; // sans doute encore en cours

      const adoptee = path.join(trash, trashNameFor(lu.cle, WORKER_ID, runId));
      try {
        await fsp.rename(cible, adoptee);
        cible = adoptee;
        adoptees += 1;
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.error(`[MediaPartitions] adoption de ${e.name} échouée:`, err.message);
        }
        continue; // une autre instance l'a adoptée
      }
    }

    const mesure = await measureDir(cible);
    try {
      await fsp.rm(cible, { recursive: true, force: true });
      partitions += 1;
      fichiers += mesure.fichiers;
      octets += mesure.octets;
    } catch (err) {
      console.error(`[MediaPartitions] effacement de ${path.basename(cible)} échoué:`, err.message);
    }
  }

  return { partitions, fichiers, octets, adoptees };
}

// ── Balayage complet ───────────────────────────────────────────────────────

/**
 * Un tour complet : réclamer les partitions échues, puis vider le sas.
 *
 * Rend un compte rendu destiné au journal `purge_runs`. La reprise après un
 * arrêt brutal est gratuite : les entrées de sas laissées par le processus
 * mort sont adoptées au tour suivant.
 */
async function sweepPartitions(opts = {}) {
  if (!PARTITIONS.enabled) {
    return { actif: false, partitions: 0, fichiers: 0, octets: 0 };
  }

  const runId = crypto.randomBytes(4).toString('hex');
  const debut = Date.now();

  const { reclamees, refuse } = await claimExpiredPartitions({ ...opts, runId });
  const vidage = await emptyTrash({ ...opts, runId });

  const compte = {
    actif: true,
    partitions: vidage.partitions,
    fichiers: vidage.fichiers,
    octets: vidage.octets,
    reclamees: reclamees.map((r) => r.cle),
    adoptees: vidage.adoptees,
    dureeMs: Date.now() - debut,
    ...(refuse ? { refuse } : {}),
  };

  if (compte.partitions > 0 || refuse) {
    console.log(
      `[MediaPartitions] ${compte.partitions} partition(s), ${compte.fichiers} fichier(s), `
      + `${(compte.octets / 1024 / 1024).toFixed(1)} Mo libérés en ${compte.dureeMs} ms`
      + (refuse ? ' — CRAN D\'ARRÊT déclenché, rien supprimé' : ''),
    );
  }
  return compte;
}

module.exports = {
  WORKER_ID,
  UPLOADS_DIR,
  relinkForForward,
  MEDIA_DIR,
  TRASH_PATH,
  resolveUploadDirSync,
  listPartitions,
  measureDir,
  partitionStats,
  claimExpiredPartitions,
  emptyTrash,
  sweepPartitions,
};
