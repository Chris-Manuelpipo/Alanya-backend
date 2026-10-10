/**
 * Copie des médias de discussion du bucket privé de Backblaze vers celui de
 * Cloudflare R2.
 *
 * Lancé par `scripts/maintenance/migrate-private-to-r2.js`, qui n'en est que
 * l'entrée. La logique vit ici, avec son stockage remplaçable, pour être
 * éprouvée sans réseau (privateBucketMigration.test.js).
 *
 * Tout ce qui est sous `media/` dans l'ancien bucket est copié sous la même
 * clé chez R2, sauf ce qui y est déjà avec la même taille. Le contenu passe
 * par la machine qui lance le script : les deux services ne se connaissent
 * pas. Rejouable : une seconde exécution ne recopie que ce qui manque.
 *
 * Rien n'est supprimé chez Backblaze : l'ancien bucket se vide à part, une
 * fois la bascule vérifiée.
 */

const storageReel = require('./mediaStorage');
const { MEDIA_ROOT } = require('../utils/mediaPartition');

const taillesPar = (objets) => new Map(objets.map((o) => [o.key, o.size]));

/**
 * @param {object} [opts]
 * @param {boolean} [opts.appliquer]  sans lui, simulation : rien n'est écrit
 */
async function executer({ appliquer = false, storage = storageReel, log = console.log } = {}) {
  const etat = storage.etatMigrationPrivee();
  if (!etat.r2 || !etat.ancien) {
    throw new Error(
      'Il faut les deux buckets privés dans le .env : R2_ENDPOINT, R2_BUCKET, R2_KEY_ID, R2_APP_KEY '
      + '(destination) et B2_ENDPOINT, B2_REGION, B2_BUCKET, B2_KEY_ID, B2_APP_KEY (origine).',
    );
  }

  const prefixe = `${MEDIA_ROOT}/`;
  const sources = await storage.listPrefix(prefixe, { depuis: 'ancien' });
  const presents = taillesPar(await storage.listPrefix(prefixe, { depuis: 'prive' }));
  const rapport = { sources: sources.length, dejaLa: 0, aCopier: 0, octets: 0, copies: 0, echecs: 0, manquants: 0 };

  for (const o of sources) {
    if (presents.get(o.key) === o.size) {
      rapport.dejaLa += 1;
      continue;
    }
    rapport.aCopier += 1;
    rapport.octets += o.size;
    if (!appliquer) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const objet = await storage.readPrivateObject(o.key, { depuis: 'ancien' });
      // eslint-disable-next-line no-await-in-loop
      await storage.putBody(o.key, objet.Body, { contentType: objet.ContentType });
      rapport.copies += 1;
    } catch (e) {
      // Supprimé entre la liste et la copie (purge, vue unique), ou réseau :
      // une nouvelle exécution le dira.
      rapport.echecs += 1;
      log(`  ✗ ${o.key} : ${e.message}`);
    }
  }

  if (appliquer) {
    // Relecture de R2 : ce qui compte est ce qui s'y trouve, pas ce qu'on
    // croit y avoir déposé.
    const apres = taillesPar(await storage.listPrefix(prefixe, { depuis: 'prive' }));
    rapport.manquants = sources.filter((o) => apres.get(o.key) !== o.size).length;
  }
  return rapport;
}

module.exports = { executer };
