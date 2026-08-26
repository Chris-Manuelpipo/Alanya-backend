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
// N'apparier que lorsque le choix est forcé. À privilégier dès que le
// mode --verifier montre des erreurs en stratégie chronologique.
const PRUDENT = process.argv.includes('--prudent');
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
function apparier(messages, parExpediteur, journal = null, { prudent = false } = {}) {
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

    // Mode prudent : on ne propose QUE lorsque le choix est forcé — un seul
    // candidat possible. Dès qu'il faut départager, on s'abstient.
    //
    // C'est le seul mode honnête pour les rafales. Quand plusieurs médias
    // partent en parallèle et que `mediaSize` manque (le cas de 96 % des
    // messages concernés, trop anciens pour la migration 018), AUCUN signal
    // disponible ne dit quel fichier va à quel message : ni l'horodatage, qui
    // reflète l'ordre d'arrivée des requêtes et non l'ordre d'envoi, ni
    // `sendAt`, qui n'a qu'une précision à la seconde. Trancher revient alors
    // à tirer à pile ou face — et une erreur ici publie une photo dans la
    // mauvaise conversation.
    if (prudent && candidats.length > 1) {
      if (journal) journal.abstentionAmbigu += 1;
      continue;
    }

    const choisi = candidats[0]; // listes déjà triées par ts croissant
    pris.add(choisi.chemin);
    couples.set(msg.msgID, choisi);
    if (journal) journal.motifs[motif] = (journal.motifs[motif] || 0) + 1;
  }
  return couples;
}

/** Compteurs de diagnostic, pour que le verdict explique COMMENT il a décidé. */
const journalNeuf = () => ({ motifs: {}, abstentionTaille: 0, sansTaille: 0, abstentionAmbigu: 0 });

/**
 * Mesure la justesse de l'appariement sur les messages qui ont CONSERVÉ leur
 * adresse : on la masque, on laisse l'algorithme la retrouver, on compare.
 *
 * Ces messages concourent avec les autres exactement comme dans une vraie
 * exécution — sans quoi la mesure serait plus facile que la réalité.
 */
async function verifier(pool, parExpediteur, tousMessages) {
  const [connus] = await pool.execute(`
    SELECT msgID, senderID, conversationID,
           UNIX_TIMESTAMP(sendAt) * 1000 AS envoiMs, mediaUrl, mediaSize
      FROM message
     WHERE mediaUrl IS NOT NULL AND mediaUrl <> ''`);
  const attendu = new Map(
    connus.map((r) => [r.msgID, String(r.mediaUrl).split('/uploads/')[1]]),
  );
  // Propriétaire réel de chaque fichier, pour savoir si une erreur reste dans
  // la même conversation ou change carrément de fil.
  const proprietaire = new Map();
  for (const r of connus) {
    proprietaire.set(String(r.mediaUrl).split('/uploads/')[1], r);
  }
  const convParMsg = new Map(connus.map((r) => [r.msgID, r.conversationID]));

  const mesurer = (options) => {
    const journal = journalNeuf();
    const couples = apparier([...tousMessages, ...connus], parExpediteur, journal, options);
    let juste = 0; let faux = 0; let absent = 0; let fauxMemeConv = 0;
    const exemples = [];
    for (const [msgID, cheminAttendu] of attendu) {
      const trouve = couples.get(msgID);
      if (!trouve) { absent += 1; continue; }
      if (trouve.chemin === cheminAttendu) { juste += 1; continue; }
      faux += 1;
      const vrai = proprietaire.get(trouve.chemin);
      if (vrai && convParMsg.get(msgID) === vrai.conversationID) fauxMemeConv += 1;
      if (exemples.length < 5) {
        exemples.push(`    msg ${msgID} : trouvé ${trouve.chemin} / attendu ${cheminAttendu}`);
      }
    }
    return { journal, juste, faux, absent, fauxMemeConv, exemples };
  };

  const chrono = mesurer({ prudent: false });
  const prudent = mesurer({ prudent: true });

  const ligne = (nom, r) => {
    const proposes = r.juste + r.faux;
    const taux = proposes ? `${((r.juste / proposes) * 100).toFixed(1)} %` : '—';
    console.log(
      `  ${nom.padEnd(22)} ${String(r.juste).padStart(5)} justes  `
      + `${String(r.faux).padStart(4)} erreurs  ${String(r.absent).padStart(4)} abstentions  ${taux}`,
    );
  };

  console.log('── Vérification sur les adresses encore intactes ──');
  console.log(`  paires de contrôle : ${attendu.size}\n`);
  console.log('  Stratégie                justes   erreurs   abstentions   justesse');
  console.log('  ' + '─'.repeat(68));
  ligne('chronologique', chrono);
  ligne('prudente', prudent);

  if (chrono.faux) {
    console.log(`\n  Erreurs du mode chronologique : ${chrono.faux}`);
    console.log(`    dont dans la MÊME conversation : ${chrono.fauxMemeConv}`);
    console.log(`    dont dans une AUTRE conversation : ${chrono.faux - chrono.fauxMemeConv}`);
    console.log('  exemples :');
    for (const e of chrono.exemples) console.log(e);
  }

  console.log('\n  Décisions du mode prudent :');
  for (const [motif, n] of Object.entries(prudent.journal.motifs)) {
    console.log(`    ${motif.padEnd(24)} : ${n}`);
  }
  console.log(`    abstention (choix ambigu)                : ${prudent.journal.abstentionAmbigu}`);
  console.log(`    abstention (taille absente de la fenêtre) : ${prudent.journal.abstentionTaille}`);
  console.log(`    messages sans mediaSize en base           : ${prudent.journal.sansTaille}`);

  if (prudent.faux === 0 && prudent.juste > 0) {
    console.log(
      `\n  ✔ Mode PRUDENT : ${prudent.juste} paires retrouvées sans une seule erreur.`
      + '\n    Relancer avec --prudent pour appliquer cette stratégie.',
    );
  } else if (prudent.juste === 0) {
    console.log('\n  ⚠ Le mode prudent ne propose rien : inventaire incomplet ?');
  } else {
    console.log('\n  ✖ Même le mode prudent se trompe : NE PAS appliquer, signaler la sortie.');
  }
  return { chrono, prudent };
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
  const couples = apparier(cibles, libres, journal, { prudent: PRUDENT });
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
