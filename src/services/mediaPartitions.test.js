// L'interrupteur est lu à l'import : il faut le poser avant le `require`.
process.env.MEDIA_PARTITIONS_ENABLED = '1';
process.env.MEDIA_PARTITIONS_MAX_DROPS = '3';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  WORKER_ID,
  listPartitions,
  measureDir,
  partitionStats,
  claimExpiredPartitions,
  emptyTrash,
  sweepPartitions,
  relinkForForward,
} = require('./mediaPartitions');
const { trashNameFor } = require('../utils/mediaPartition');

const MAINTENANT = Date.parse('2026-08-25T12:00:00Z');
const RETENTION = 30;

/** Racine jetable : ces tests exercent `rename` et `rm -rf` sur des arborescences. */
function racineNeuve() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alanya-partitions-'));
  return root;
}

function poserMedia(root, partition, kind, nom, contenu = 'x') {
  const dir = path.join(root, 'media', partition, kind);
  fs.mkdirSync(dir, { recursive: true });
  const complet = path.join(dir, nom);
  fs.writeFileSync(complet, contenu);
  return complet;
}

async function main() {
  // ── Inventaire : les dossiers hérités ne sont jamais pris pour des partitions
  {
    const root = racineNeuve();
    poserMedia(root, '2026-07-20', 'images', 'media_1_1.jpg');
    poserMedia(root, '2026-08-24', 'video', 'media_2_2.mp4');
    // Disposition historique, qui cohabite pendant toute la transition.
    fs.mkdirSync(path.join(root, 'media', 'images'), { recursive: true });
    fs.writeFileSync(path.join(root, 'media', 'images', 'media_3_3.jpg'), 'x');
    fs.mkdirSync(path.join(root, 'media', 'files'), { recursive: true });

    const partitions = await listPartitions({ root });
    assert.deepStrictEqual(partitions, ['2026-07-20', '2026-08-24']);
  }

  // ── Statistiques : ce qui tomberait maintenant
  {
    const root = racineNeuve();
    poserMedia(root, '2026-07-20', 'images', 'media_1_1.jpg', 'abcde'); // échue
    poserMedia(root, '2026-08-24', 'images', 'media_2_2.jpg', 'xyz');   // vivante

    const s = await partitionStats({ retentionDays: RETENTION, now: MAINTENANT, root });
    assert.strictEqual(s.partitionsEchues, 1);
    assert.strictEqual(s.partitionsVivantes, 1);
    assert.strictEqual(s.fichiers, 1);
    assert.strictEqual(s.octets, 5);
    assert.strictEqual(s.plusAncienne, '2026-07-20');
    assert.strictEqual(s.bloqueParCranArret, false);
  }

  // ── Réclamation : la partition échue part, le reste ne bouge pas
  {
    const root = racineNeuve();
    poserMedia(root, '2026-07-20', 'images', 'media_1_1.jpg');
    poserMedia(root, '2026-08-24', 'images', 'media_2_2.jpg');
    const herite = path.join(root, 'media', 'images', 'media_3_3.jpg');
    fs.mkdirSync(path.dirname(herite), { recursive: true });
    fs.writeFileSync(herite, 'x');

    const { reclamees, refuse } = await claimExpiredPartitions({
      retentionDays: RETENTION, now: MAINTENANT, root,
    });

    assert.strictEqual(refuse, null);
    assert.deepStrictEqual(reclamees.map((r) => r.cle), ['2026-07-20']);

    // La partition échue a quitté l'espace servi…
    assert.ok(!fs.existsSync(path.join(root, 'media', '2026-07-20')));
    // …la vivante est intacte…
    assert.ok(fs.existsSync(path.join(root, 'media', '2026-08-24', 'images', 'media_2_2.jpg')));
    // …et la disposition historique n'est jamais touchée par le balayage.
    assert.ok(fs.existsSync(herite));

    // Elle est dans le sas, sous un nom qui porte le worker et l'exécution.
    const sas = await fsp.readdir(path.join(root, '.trash'));
    assert.strictEqual(sas.length, 1);
    assert.ok(sas[0].startsWith('2026-07-20__'));
  }

  // ── Cran d'arrêt : au-delà du seuil, on ne supprime RIEN, pas « les premières »
  {
    const root = racineNeuve();
    // 4 partitions échues pour un seuil réglé à 3.
    for (const j of ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04']) {
      poserMedia(root, j, 'images', `media_1_${j}.jpg`);
    }

    const { reclamees, refuse } = await claimExpiredPartitions({
      retentionDays: RETENTION, now: MAINTENANT, root,
    });

    assert.deepStrictEqual(reclamees, []);
    assert.strictEqual(refuse.raison, 'CRAN_ARRET');
    assert.strictEqual(refuse.echues, 4);
    assert.strictEqual(refuse.seuil, 3);

    // Aucune partition n'a bougé : un dégât partiel serait pire qu'un arrêt net.
    for (const j of ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04']) {
      assert.ok(fs.existsSync(path.join(root, 'media', j)), `${j} doit être intacte`);
    }

    // `force` lève explicitement le garde-fou — c'est le mode de rattrapage
    // après une longue coupure, jamais le comportement par défaut.
    const forcee = await claimExpiredPartitions({
      retentionDays: RETENTION, now: MAINTENANT, root, force: true,
    });
    assert.strictEqual(forcee.reclamees.length, 4);
  }

  // ── Liens matériels : les octets ne sont comptés qu'une fois
  {
    const root = racineNeuve();
    const origine = poserMedia(root, '2026-07-20', 'images', 'media_1_1.jpg', '0123456789');
    // Le transfert d'un média crée un lien vers le même inode dans la
    // partition du jour : l'espace n'est rendu qu'à la chute de la dernière.
    const dirTransfert = path.join(root, 'media', '2026-08-24', 'images');
    fs.mkdirSync(dirTransfert, { recursive: true });
    fs.linkSync(origine, path.join(dirTransfert, 'media_1_9.jpg'));

    const mesureOrigine = await measureDir(path.join(root, 'media', '2026-07-20'));
    assert.strictEqual(mesureOrigine.fichiers, 1);
    assert.strictEqual(mesureOrigine.octets, 0, 'un fichier encore lié ne libère aucun octet');

    // Une fois le second lien retiré, les octets redeviennent réels.
    fs.unlinkSync(path.join(dirTransfert, 'media_1_9.jpg'));
    const apres = await measureDir(path.join(root, 'media', '2026-07-20'));
    assert.strictEqual(apres.octets, 10);
  }

  // ── Vidage du sas : le mien part, celui d'un autre attend, le vieux est adopté
  {
    const root = racineNeuve();
    const sas = path.join(root, '.trash');
    fs.mkdirSync(sas, { recursive: true });

    const mien = path.join(sas, trashNameFor('2026-07-01', WORKER_ID, 'run-a'));
    fs.mkdirSync(path.join(mien, 'images'), { recursive: true });
    fs.writeFileSync(path.join(mien, 'images', 'a.jpg'), 'abc');

    const autreRecent = path.join(sas, trashNameFor('2026-07-02', 'autre-worker', 'run-b'));
    fs.mkdirSync(autreRecent, { recursive: true });

    const autreVieux = path.join(sas, trashNameFor('2026-07-03', 'worker-mort', 'run-c'));
    fs.mkdirSync(path.join(autreVieux, 'video'), { recursive: true });
    fs.writeFileSync(path.join(autreVieux, 'video', 'b.mp4'), 'defgh');
    // Daté d'il y a deux heures : le processus qui l'a réclamé est mort.
    const vieux = new Date(MAINTENANT - 2 * 60 * 60 * 1000);
    fs.utimesSync(autreVieux, vieux, vieux);

    // Un nom qui ne vient pas de `trashNameFor` : on n'y touche pas.
    const intrus = path.join(sas, 'quelque-chose-dautre');
    fs.mkdirSync(intrus, { recursive: true });

    const bilan = await emptyTrash({
      root, now: MAINTENANT, adoptAfterMs: 60 * 60 * 1000,
    });

    assert.ok(!fs.existsSync(mien), 'ma propre réclamation doit être effacée');
    assert.ok(fs.existsSync(autreRecent), "une réclamation étrangère récente est sans doute en cours d'effacement");
    assert.ok(fs.existsSync(intrus), 'un répertoire au nom inattendu ne doit jamais être supprimé');
    assert.strictEqual(bilan.partitions, 2); // le mien + l'adopté
    assert.strictEqual(bilan.adoptees, 1);
    assert.strictEqual(bilan.fichiers, 2);
    assert.strictEqual(bilan.octets, 8);

    const restant = await fsp.readdir(sas);
    assert.ok(!restant.some((n) => n.startsWith('2026-07-03__')), "l'entrée adoptée doit avoir disparu");
  }

  // ── Balayage complet
  {
    const root = racineNeuve();
    poserMedia(root, '2026-07-20', 'images', 'media_1_1.jpg', 'abcdefgh');
    poserMedia(root, '2026-08-24', 'images', 'media_2_2.jpg', 'ij');

    const compte = await sweepPartitions({ retentionDays: RETENTION, now: MAINTENANT, root });

    assert.strictEqual(compte.actif, true);
    assert.strictEqual(compte.partitions, 1);
    assert.strictEqual(compte.fichiers, 1);
    assert.strictEqual(compte.octets, 8);
    assert.deepStrictEqual(compte.reclamees, ['2026-07-20']);

    assert.ok(!fs.existsSync(path.join(root, 'media', '2026-07-20')));
    assert.ok(fs.existsSync(path.join(root, 'media', '2026-08-24', 'images', 'media_2_2.jpg')));

    // Idempotence : un second tour ne trouve plus rien et ne casse rien.
    const encore = await sweepPartitions({ retentionDays: RETENTION, now: MAINTENANT, root });
    assert.strictEqual(encore.partitions, 0);
  }

  // ── Rattrapage : serveur éteint longtemps, les partitions tombent d'un coup
  {
    const root = racineNeuve();
    for (const j of ['2026-06-01', '2026-06-02']) poserMedia(root, j, 'images', `m_${j}.jpg`);
    const compte = await sweepPartitions({
      retentionDays: RETENTION, now: MAINTENANT, root, force: true,
    });
    assert.strictEqual(compte.partitions, 2);
  }

  // ── Transfert : un lien matériel, pas une copie
  {
    const root = racineNeuve();
    const source = poserMedia(root, '2026-07-20', 'images', 'media_7_1753000000000.jpg', '0123456789');
    const instant = Date.parse('2026-08-25T09:00:00Z');

    const chemin = relinkForForward(
      `https://exemple.test/uploads/media/2026-07-20/images/media_7_1753000000000.jpg`,
      { alanyaID: 42, instant, root },
    );

    // Le transfert atterrit dans la partition du JOUR DU TRANSFERT, avec un nom
    // qui suit la convention : sa partition reste déductible du nom de fichier.
    assert.strictEqual(chemin, `media/2026-08-25/images/media_42_${instant}.jpg`);
    const destination = path.join(root, chemin);
    assert.ok(fs.existsSync(destination));

    // Même inode : zéro octet copié, et l'espace n'est rendu qu'au dernier lien.
    assert.strictEqual(fs.statSync(destination).ino, fs.statSync(source).ino);
    assert.strictEqual(fs.statSync(destination).nlink, 2);

    // La chute de la partition d'origine ne casse pas le transfert : c'est tout
    // l'objet du correctif. Le fichier d'origine disparaît, le contenu reste
    // accessible par le lien de la partition récente.
    await sweepPartitions({ retentionDays: RETENTION, now: MAINTENANT, root });
    assert.ok(!fs.existsSync(source), "l'original est bien tombé avec sa partition");
    assert.ok(fs.existsSync(destination), 'le transfert doit survivre');
    assert.strictEqual(fs.readFileSync(destination, 'utf8'), '0123456789');
    assert.strictEqual(fs.statSync(destination).nlink, 1);
  }

  // ── Transfert : refus des chemins qui ne sont pas des médias de message
  {
    const root = racineNeuve();
    const opts = { alanyaID: 42, instant: Date.parse('2026-08-25T09:00:00Z'), root };

    // Un avatar n'expire pas : rien à relier.
    assert.strictEqual(relinkForForward('/uploads/images/img_7_1.jpg', opts), null);
    // Une remontée de répertoire ne doit jamais être suivie.
    assert.strictEqual(relinkForForward('/uploads/media/../../etc/passwd', opts), null);
    assert.strictEqual(relinkForForward('/uploads/media/..%2F..%2Fetc/passwd', opts), null);
    // Un sous-dossier inconnu n'est pas un type de média.
    assert.strictEqual(relinkForForward('/uploads/media/2026-08-25/exotique/x.jpg', opts), null);
    // Fichier source absent : on retombe sur l'URL d'origine côté appelant.
    assert.strictEqual(relinkForForward('/uploads/media/2026-08-25/images/absent.jpg', opts), null);
    assert.strictEqual(relinkForForward('', opts), null);
    assert.strictEqual(relinkForForward(null, opts), null);
  }

  console.log('mediaPartitions: OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
