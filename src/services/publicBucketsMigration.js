/**
 * Répartition des fichiers existants dans les buckets publics.
 *
 * Conception : docs/conception/medias-buckets.html, section 09. Lancé par
 * `scripts/maintenance/migrate-public-buckets.js`, qui n'en est que l'entrée.
 * La logique vit ici, avec ses dépendances remplaçables, pour être éprouvée
 * sans base ni Backblaze (publicBucketsMigration.test.js).
 *
 * Trois étapes, toutes rejouables : une seconde exécution ne refait rien de
 * ce que la première a fait.
 *
 *  1. Copie. Tout fichier sous `images/`, `voicemail/`, `official/` ou
 *     `ringtones/`, dans le bucket privé, est copié
 *     dans son bucket public s'il n'y est pas déjà. Le contenu passe par la
 *     machine qui lance le script : chaque clé Backblaze est limitée à son
 *     bucket, aucune ne peut copier de l'un à l'autre.
 *  2. Médias officiels. Les médias des diffusions et de l'accueil, rangés
 *     jusqu'ici comme des médias de discussion (`media/<jour>/…`), sont copiés
 *     sous `official/` et leurs adresses réécrites partout où elles figurent :
 *     configuration, messages et stories du compte officiel.
 *  3. Adresses. Les photos de profil, de groupe et les annonces désignées par
 *     une adresse du serveur (`…/uploads/images/…`) reçoivent leur adresse
 *     publique directe — seulement si le fichier est bien dans son bucket.
 *
 * Et, à part (`nettoyer`), la suppression dans le bucket privé de ce qui a été
 * copié. Jamais lancée par défaut : on vérifie d'abord, puis on nettoie.
 */

const pool = require('../config/db');
const storageReel = require('./mediaStorage');
const { ACCOUNT_TYPE } = require('../constants/accountTypes');

const PREFIXES_PUBLICS = ['images', 'voicemail', 'official', 'ringtones'];

/** Configuration des médias officiels : table, colonne. */
const TABLES_OFFICIELLES = [
  ['broadcast', 'media_url'],
  ['welcome_block', 'media_url'],
  ['welcome_status_config', 'media_url'],
  ['welcome_status_block', 'media_url'],
];

/** Colonnes qui désignent une photo ou une annonce : table, colonne, clé primaire. */
const COLONNES_PUBLIQUES = [
  ['users', 'avatar_url', 'alanyaID'],
  ['conversation', 'groupPhoto', 'conversID'],
  ['user_voicemail_schedule', 'greeting_url', 'alanyaID'],
];

const tableAbsente = (e) => e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR');

/**
 * Copie `source`, une clé du bucket privé, sous `cible`, dans son bucket
 * public. Le contenu passe par la machine qui lance le script : chaque clé
 * Backblaze est limitée à son bucket, aucune ne peut copier de l'un à l'autre.
 */
async function copier({ storage }, source, cible) {
  const objet = await storage.readPrivateObject(source);
  await storage.putBody(cible, objet.Body, { contentType: objet.ContentType });
}

// ── 1. Copie ────────────────────────────────────────────────────────────────

/**
 * @returns {Promise<{ disponibles: Set<string>, rapport: object }>}
 *   `disponibles` : les clés présentes dans leur bucket public à l'issue de
 *   l'étape — ou qui le seraient, en simulation.
 */
async function copierFichiersPublics({ storage, appliquer, log }) {
  const disponibles = new Set();
  const rapport = { dejaLa: 0, aCopier: 0, copies: 0, echecs: 0 };
  for (const prefixe of PREFIXES_PUBLICS) {
    for (const o of await storage.listPrefix(`${prefixe}/`)) disponibles.add(o.key);
    const prives = (await storage.listPrefix(`${prefixe}/`, { depuis: 'prive' })).map((o) => o.key);

    for (const cle of new Set(prives)) {
      if (disponibles.has(cle)) {
        rapport.dejaLa += 1;
        continue;
      }
      rapport.aCopier += 1;
      if (!appliquer) {
        disponibles.add(cle);
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await copier({ storage }, cle, cle);
        disponibles.add(cle);
        rapport.copies += 1;
      } catch (e) {
        rapport.echecs += 1;
        log(`  échec de la copie de ${cle} : ${e.message}`);
      }
    }
  }
  return { disponibles, rapport };
}

// ── 2. Médias officiels ─────────────────────────────────────────────────────

async function comptesOfficiels(db) {
  const ids = new Set();
  const [officiels] = await db.execute('SELECT alanyaID FROM users WHERE account_type = ?', [ACCOUNT_TYPE.OFFICIEL]);
  for (const r of officiels) ids.add(Number(r.alanyaID));
  try {
    const [expediteurs] = await db.execute('SELECT DISTINCT sender_id FROM broadcast');
    for (const r of expediteurs) if (r.sender_id != null) ids.add(Number(r.sender_id));
  } catch (e) {
    if (!tableAbsente(e)) throw e;
  }
  return [...ids].filter((n) => n > 0);
}

async function migrerMediasOfficiels({ db, storage, appliquer, disponibles, log }) {
  const rapport = { adresses: 0, aCopier: 0, copies: 0, introuvables: 0, echecs: 0 };
  const expediteurs = await comptesOfficiels(db);
  const enClause = expediteurs.map(() => '?').join(',');

  const urls = new Set();
  for (const [table, col] of TABLES_OFFICIELLES) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const [rows] = await db.execute(
        `SELECT DISTINCT ${col} AS url FROM ${table} WHERE ${col} LIKE '%/uploads/media/%'`,
      );
      for (const r of rows) urls.add(r.url);
    } catch (e) {
      if (!tableAbsente(e)) throw e;
    }
  }
  if (expediteurs.length) {
    const [messages] = await db.execute(
      `SELECT DISTINCT mediaUrl AS url FROM message
        WHERE senderID IN (${enClause}) AND mediaUrl LIKE '%/uploads/media/%'
          AND (clientID LIKE 'broadcast:%' OR clientID LIKE 'welcome:%')`,
      expediteurs,
    );
    for (const r of messages) urls.add(r.url);
    const [stories] = await db.execute(
      `SELECT DISTINCT mediaUrl AS url FROM statut
        WHERE alanyaID IN (${enClause}) AND mediaUrl LIKE '%/uploads/media/%'`,
      expediteurs,
    );
    for (const r of stories) urls.add(r.url);
  }

  for (const url of urls) {
    const source = storage.storedKeyFromUrl(url);
    if (!source || !source.startsWith('media/')) continue;
    const segments = source.split('/');
    const cible = `official/${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
    const nouvelle = storage.publicUrl(cible);

    if (!disponibles.has(cible)) {
      // eslint-disable-next-line no-await-in-loop
      const present = await storage.headObject(source, { depuis: 'prive' });
      if (!present) {
        // Déjà expiré et supprimé : l'adresse est laissée telle quelle, le
        // serveur y répond « expiré ».
        rapport.introuvables += 1;
        log(`  introuvable, adresse laissée : ${url}`);
        continue;
      }
      rapport.aCopier += 1;
      if (appliquer) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await copier({ storage }, source, cible);
          rapport.copies += 1;
        } catch (e) {
          rapport.echecs += 1;
          log(`  échec de la copie de ${source} : ${e.message}`);
          continue;
        }
      }
      disponibles.add(cible);
    }

    rapport.adresses += 1;
    if (!appliquer) continue;
    for (const [table, col] of TABLES_OFFICIELLES) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await db.execute(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`, [nouvelle, url]);
      } catch (e) {
        if (!tableAbsente(e)) throw e;
      }
    }
    if (expediteurs.length) {
      // L'index (senderID, clientID) borne ces deux mises à jour aux lignes
      // du compte officiel : jamais de balayage de toute la table.
      // eslint-disable-next-line no-await-in-loop
      await db.execute(
        `UPDATE message SET mediaUrl = ? WHERE senderID IN (${enClause}) AND mediaUrl = ?`,
        [nouvelle, ...expediteurs, url],
      );
      // eslint-disable-next-line no-await-in-loop
      await db.execute(
        `UPDATE statut SET mediaUrl = ? WHERE alanyaID IN (${enClause}) AND mediaUrl = ?`,
        [nouvelle, ...expediteurs, url],
      );
    }
  }
  return rapport;
}

// ── 3. Adresses des photos et des annonces ──────────────────────────────────

async function reecrireAdresses({ db, storage, appliquer, disponibles }) {
  const rapport = { aReecrire: 0, reecrites: 0, fichierAbsent: 0 };
  for (const [table, col, cle] of COLONNES_PUBLIQUES) {
    let rows;
    try {
      // eslint-disable-next-line no-await-in-loop
      [rows] = await db.execute(
        `SELECT ${cle} AS id, ${col} AS url FROM ${table}
          WHERE ${col} LIKE '%/uploads/images/%' OR ${col} LIKE '%/uploads/voicemail/%'`,
      );
    } catch (e) {
      if (tableAbsente(e)) continue;
      throw e;
    }
    for (const r of rows) {
      const key = storage.keyFromUrl(r.url);
      if (!key || !['images', 'voicemail'].includes(key.split('/')[0])) continue;
      // Jamais une adresse vers un fichier absent : la ligne garde l'ancienne,
      // que le serveur continue de servir.
      if (!disponibles.has(key)) {
        rapport.fichierAbsent += 1;
        continue;
      }
      const nouvelle = storage.publicUrl(key);
      if (nouvelle === r.url) continue;
      rapport.aReecrire += 1;
      if (!appliquer) continue;
      // Par clé primaire, et seulement si la ligne n'a pas changé entre-temps.
      // eslint-disable-next-line no-await-in-loop
      const [res] = await db.execute(
        `UPDATE ${table} SET ${col} = ? WHERE ${cle} = ? AND ${col} = ?`,
        [nouvelle, r.id, r.url],
      );
      rapport.reecrites += res.affectedRows || 0;
    }
  }
  return rapport;
}

// ── Nettoyage du bucket privé ───────────────────────────────────────────────

async function nettoyerPrive({ storage, appliquer, log }) {
  const rapport = { aSupprimer: 0, supprimes: 0, gardes: 0 };
  for (const prefixe of PREFIXES_PUBLICS) {
    const copies = new Set((await storage.listPrefix(`${prefixe}/`)).map((o) => o.key));
    for (const o of await storage.listPrefix(`${prefixe}/`, { depuis: 'prive' })) {
      // Seulement ce dont la copie est vérifiée dans le bucket public.
      if (!copies.has(o.key)) {
        rapport.gardes += 1;
        log(`  gardé, pas de copie publique : ${o.key}`);
        continue;
      }
      rapport.aSupprimer += 1;
      if (!appliquer) continue;
      // eslint-disable-next-line no-await-in-loop
      await storage.removeAllVersions(o.key, { seulement: 'prive' });
      rapport.supprimes += 1;
    }
  }
  return rapport;
}

// ── Entrée ──────────────────────────────────────────────────────────────────

/**
 * @param {object} [opts]
 * @param {boolean} [opts.appliquer]  sans lui, simulation : rien n'est écrit
 * @param {boolean} [opts.nettoyer]   supprime du privé ce qui est copié, et rien d'autre
 */
async function executer({
  appliquer = false,
  nettoyer = false,
  db = pool,
  storage = storageReel,
  log = console.log,
} = {}) {
  if (!storage.cibleDe('images/x').publique || !storage.cibleDe('voicemail/x').publique) {
    throw new Error(
      'Buckets publics non configurés : B2_* (bucket privé), B2_PROFILE_* et B2_PROFILEMEDIA_* '
      + '(nom, clé, secret) dans le .env.',
    );
  }
  if (nettoyer) return { nettoyage: await nettoyerPrive({ storage, appliquer, log }) };

  const { disponibles, rapport: copie } = await copierFichiersPublics({ storage, appliquer, log });
  const officiels = await migrerMediasOfficiels({ db, storage, appliquer, disponibles, log });
  const adresses = await reecrireAdresses({ db, storage, appliquer, disponibles });
  return { copie, officiels, adresses };
}

module.exports = { executer, PREFIXES_PUBLICS };
