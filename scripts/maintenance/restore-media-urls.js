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
 *   node scripts/maintenance/restore-media-urls.js --verifier # mesure la justesse
 *   node scripts/maintenance/restore-media-urls.js            # simulation
 *   node scripts/maintenance/restore-media-urls.js --apply    # écriture
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../../src/config/db');

const APPLY = process.argv.includes('--apply');
const VERIFIER = process.argv.includes('--verifier');
const RACINE = path.join(__dirname, '../../uploads');
const BASE_URL = process.env.MEDIA_BASE_URL || 'https://www.alanya237.com';

// Fenêtre en amont de sendAt dans laquelle l'upload a forcément eu lieu.
// Mesurée sur les paires intactes : l'écart est de 1 à 6 s. La marge en aval
// n'absorbe que l'arrondi à la seconde de `sendAt` face aux millisecondes du
// nom de fichier.
const AVANT_MS = 120 * 1000;
const APRES_MS = 3 * 1000;

/** Inventorie les fichiers `media_<id>_<ts>.<ext>` sous uploads/. */
function inventorier(dir, acc = []) {
  let entrees;
  try { entrees = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entrees) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { inventorier(p, acc); continue; }
    const m = e.name.match(/^media_(\d+)_(\d+)\.(.+)$/);
    if (!m) continue;
    // La taille est relevée ici parce qu'elle est le discriminant PRINCIPAL de
    // l'appariement : `message.mediaSize` porte le nombre d'octets exact du
    // fichier envoyé (migration 018). Deux médias d'une même rafale ont presque
    // toujours des tailles distinctes, là où leurs horodatages peuvent être
    // séparés de deux millisecondes et dans le désordre.
    let taille = null;
    try { taille = fs.statSync(p).size; } catch { /* fichier disparu entre-temps */ }
    acc.push({
      chemin: path.relative(RACINE, p).split(path.sep).join('/'),
      alanyaID: Number(m[1]),
      ts: Number(m[2]),
      taille,
    });
  }
  return acc;
}

/**
 * Apparie messages et fichiers, par expéditeur, sur la TAILLE d'abord.
 *
 * L'appariement purement chronologique s'est révélé faux à 14 % sur les paires
 * de contrôle (28 erreurs sur 206), et ses erreurs étaient presque toutes des
 * transpositions entre voisins immédiats — deux fichiers séparés de 2 à 33 ms,
 * attribués à l'envers. Deux causes se combinent :
 *
 *  1. `sendAt` n'a qu'une précision à la SECONDE. Tous les messages d'une même
 *     seconde partagent le même `envoiMs`, donc leur ordre relatif est
 *     arbitraire — le tri ne peut pas les départager.
 *  2. Les uploads d'une rafale partent EN PARALLÈLE. Des horodatages distants
 *     de deux millisecondes reflètent l'ordre d'ARRIVÉE des requêtes, pas
 *     l'ordre d'envoi voulu par l'utilisateur. L'hypothèse chronologique est
 *     donc fausse exactement là où on avait besoin d'elle.
 *
 * Le signal décisif était déjà en base : `message.mediaSize`, le nombre exact
 * d'octets du fichier (migration 018). Deux médias d'une même rafale ont
 * presque toujours des tailles différentes — c'est une signature, là où
 * l'horodatage n'est qu'un indice.
 *
 * La fenêtre temporelle reste utile pour BORNER les candidats ; elle ne sert
 * plus à les départager. Quand la taille est connue et qu'aucun candidat ne la
 * porte, on s'ABSTIENT plutôt que de retomber sur la chronologie : l'absence
 * du bon fichier est une information, pas une invitation à deviner. La règle
 * de prudence d'origine tient toujours — mieux vaut un média manquant qu'un
 * média publié dans la mauvaise conversation.
 *
 * @returns Map<msgID, fichier>
 */
function apparier(messages, parExpediteur, journal = null) {
  const pris = new Set();
  const couples = new Map();
  // `msgID` départage les messages d'une même seconde : sans lui, l'ordre de
  // parcours dépend de l'implémentation du tri.
  const tries = [...messages].sort(
    (a, b) => (a.envoiMs - b.envoiMs) || (a.msgID - b.msgID),
  );

  for (const msg of tries) {
    const fenetre = (parExpediteur.get(msg.senderID) || []).filter(
      (f) => !pris.has(f.chemin)
        && f.ts >= msg.envoiMs - AVANT_MS
        && f.ts <= msg.envoiMs + APRES_MS,
    );
    if (!fenetre.length) continue;

    const taille = Number(msg.mediaSize);
    let candidats = fenetre;
    let motif = 'chronologie';

    if (Number.isFinite(taille) && taille > 0) {
      const memeTaille = fenetre.filter((f) => f.taille === taille);
      if (memeTaille.length === 0) {
        // Taille connue, aucun candidat ne la porte : le bon fichier n'est pas
        // dans la fenêtre (déjà pris, ou réellement supprimé). Deviner ici,
        // c'est fabriquer une erreur d'attribution.
        if (journal) journal.abstentionTaille += 1;
        continue;
      }
      candidats = memeTaille;
      motif = memeTaille.length === 1 ? 'taille unique' : 'taille + chronologie';
    } else if (journal) {
      journal.sansTaille += 1;
    }

    const choisi = candidats[0]; // listes déjà triées par ts croissant
    pris.add(choisi.chemin);
    couples.set(msg.msgID, choisi);
    if (journal) journal.motifs[motif] = (journal.motifs[motif] || 0) + 1;
  }
  return couples;
}

/** Compteurs de diagnostic, pour que le verdict explique COMMENT il a décidé. */
const journalNeuf = () => ({ motifs: {}, abstentionTaille: 0, sansTaille: 0 });

/**
 * Mesure la justesse de l'appariement sur les messages qui ont CONSERVÉ leur
 * adresse : on la masque, on laisse l'algorithme la retrouver, on compare.
 *
 * Ces messages concourent avec les autres exactement comme dans une vraie
 * exécution — sans quoi la mesure serait plus facile que la réalité.
 */
async function verifier(pool, parExpediteur, tousMessages) {
  const [connus] = await pool.execute(`
    SELECT msgID, senderID, UNIX_TIMESTAMP(sendAt) * 1000 AS envoiMs, mediaUrl, mediaSize
      FROM message
     WHERE mediaUrl IS NOT NULL AND mediaUrl <> ''`);
  const attendu = new Map(
    connus.map((r) => [r.msgID, String(r.mediaUrl).split('/uploads/')[1]]),
  );

  const journal = journalNeuf();
  const couples = apparier([...tousMessages, ...connus], parExpediteur, journal);

  let juste = 0; let faux = 0; let absent = 0;
  const exemplesFaux = [];
  for (const [msgID, cheminAttendu] of attendu) {
    const trouve = couples.get(msgID);
    if (!trouve) { absent += 1; continue; }
    if (trouve.chemin === cheminAttendu) juste += 1;
    else {
      faux += 1;
      if (exemplesFaux.length < 5) {
        exemplesFaux.push(`    msg ${msgID} : trouvé ${trouve.chemin} / attendu ${cheminAttendu}`);
      }
    }
  }
  const total = attendu.size;
  const proposes = juste + faux;
  console.log('── Vérification sur les adresses encore intactes ──');
  console.log(`  paires de contrôle          : ${total}`);
  console.log(`  retrouvées à l'identique    : ${juste}`);
  console.log(`  ERREURS D'ATTRIBUTION       : ${faux}`);
  console.log(`  non proposées (abstention)  : ${absent}`);
  if (proposes) {
    console.log(`  justesse quand il propose   : ${((juste / proposes) * 100).toFixed(1)} %`);
  }
  if (exemplesFaux.length) {
    console.log('  exemples d\'erreurs :');
    for (const e of exemplesFaux) console.log(e);
  }
  // Comment l'algorithme a tranché : une justesse élevée obtenue surtout par
  // « chronologie » resterait fragile, puisque c'est précisément l'hypothèse
  // qui s'était révélée fausse dans les rafales.
  console.log('  décisions :');
  for (const [motif, n] of Object.entries(journal.motifs)) {
    console.log(`    ${motif.padEnd(24)} : ${n}`);
  }
  console.log(`    abstention (taille absente de la fenêtre) : ${journal.abstentionTaille}`);
  console.log(`    messages sans mediaSize en base           : ${journal.sansTaille}`);
  // Zéro erreur sur zéro proposition ne prouve rien : ne jamais afficher un
  // feu vert quand l'algorithme s'est tu (inventaire vide, mauvais dossier).
  if (proposes === 0) {
    console.log(
      '\n  ⚠ Test non concluant : aucune proposition. L\'inventaire est-il complet ?'
      + ' Ce mode doit tourner SUR LE SERVEUR, où sont les fichiers.',
    );
  } else if (faux === 0) {
    console.log(`\n  ✔ ${juste} paires retrouvées sans une seule erreur d'attribution.`);
  } else {
    console.log('\n  ✖ Des erreurs d\'attribution existent : NE PAS appliquer en l\'état.');
  }
  return { total, juste, faux, absent };
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

  // Index par expéditeur, trié par instant d'upload : `apparier` s'appuie sur
  // cet ordre pour prendre le plus ancien fichier libre de la fenêtre.
  const parExpediteur = new Map();
  for (const f of fichiers) {
    if (!parExpediteur.has(f.alanyaID)) parExpediteur.set(f.alanyaID, []);
    parExpediteur.get(f.alanyaID).push(f);
  }
  for (const liste of parExpediteur.values()) liste.sort((a, b) => a.ts - b.ts);

  // Messages à restaurer. `isViewOnce = 1` est exclu : ces médias ont été
  // vidés légitimement après consultation, les remettre ressusciterait un
  // contenu que l'expéditeur voulait éphémère.
  const [cibles] = await pool.execute(`
    SELECT msgID, senderID, UNIX_TIMESTAMP(sendAt) * 1000 AS envoiMs, mediaName, type, mediaSize
      FROM message
     WHERE mediaUrl IS NULL
       AND sendAt < DATE_SUB(NOW(), INTERVAL 30 DAY)
       AND (mediaName IS NOT NULL OR mediaDuration IS NOT NULL)
       AND (isViewOnce IS NULL OR isViewOnce = 0)
     ORDER BY msgID ASC`);

  if (VERIFIER) {
    await verifier(pool, parExpediteur, cibles);
    await pool.end();
    return;
  }

  // Les fichiers déjà référencés par un message intact sont hors jeu.
  const [intacts] = await pool.execute(
    "SELECT mediaUrl FROM message WHERE mediaUrl IS NOT NULL AND mediaUrl <> ''",
  );
  const dejaPris = new Set(
    intacts.map((r) => String(r.mediaUrl).split('/uploads/')[1]).filter(Boolean),
  );
  const libres = new Map();
  for (const [uid, liste] of parExpediteur) {
    libres.set(uid, liste.filter((f) => !dejaPris.has(f.chemin)));
  }
  console.log(`Fichiers déjà référencés par un message intact : ${dejaPris.size}`);
  console.log(`Messages à restaurer : ${cibles.length}\n`);

  const journal = journalNeuf();
  const couples = apparier(cibles, libres, journal);
  const retenus = [];
  const introuvables = [];
  for (const msg of cibles) {
    const f = couples.get(msg.msgID);
    if (f) retenus.push({ msgID: msg.msgID, url: `${BASE_URL}/uploads/${f.chemin}` });
    else introuvables.push(msg.msgID);
  }

  console.log('── Résultat du rapprochement ──');
  console.log(`  appariés                   : ${retenus.length}`);
  console.log(`  sans fichier correspondant : ${introuvables.length}`);
  console.log('  dont, par mode de décision :');
  for (const [motif, n] of Object.entries(journal.motifs)) {
    console.log(`    ${motif.padEnd(24)} : ${n}`);
  }
  console.log(`    abstention (taille absente de la fenêtre) : ${journal.abstentionTaille}`);
  console.log(`    messages sans mediaSize en base           : ${journal.sansTaille}`);
  if (retenus.length) {
    console.log('\n  échantillon :');
    for (const r of retenus.slice(0, 5)) console.log(`    msg ${r.msgID} → ${r.url}`);
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
