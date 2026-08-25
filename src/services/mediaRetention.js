/**
 * Médias de message — purge des fichiers physiques après rétention.
 *
 * Le message survit, le fichier non. Passé `mediaDays`, le fichier sur disque
 * (`uploads/...`) est supprimé et `message.mediaUrl` est vidée — le message
 * reste visible dans la conversation, seul le média n'est plus servable
 * depuis le serveur. Un appareil qui l'avait déjà téléchargé garde sa copie
 * locale indéfiniment (ce module ne touche jamais au téléphone).
 *
 * Même schéma que `deleteMediaFile` utilisé pour la consommation d'un média
 * « vue unique » (`messageController.js`) : on vide `mediaUrl` uniquement,
 * `mediaName`/`mediaThumb`/`mediaSize` restent pour l'historique.
 *
 * Séparé de `messageController` pour la même raison que `tripRetention` est
 * séparé de `tripWorkers` : la purge nocturne n'a besoin ni de socket, ni de
 * notifications, ni du reste de la machinerie d'envoi de message.
 */

const pool = require('../config/db');
const policy = require('../constants/mediaRetentionPolicy');
const { deleteMediaFile } = require('../utils/mediaFile');

const BATCH_SIZE = 500;

/**
 * Prédicat « ce média a dépassé sa rétention », sur un `message` aliasé `m`.
 * Il n'existe pas de colonne dédiée à l'instant d'upload : l'upload physique
 * se termine toujours AVANT la création de la ligne `message` (le client
 * uploade, reçoit une URL, puis envoie le message avec cette URL) — `sendAt`
 * est donc une référence sûre, au pire légèrement postérieure à l'upload réel.
 */
const expiredMediaWhere = () => ({
  sql: `m.mediaUrl IS NOT NULL AND m.mediaUrl <> ''
          AND m.sendAt < DATE_SUB(NOW(), INTERVAL ? DAY)`,
  params: [policy.RETENTION.mediaDays],
});

/** Purge un lot de médias expirés. Renvoie le nombre de lignes traitées. */
const purgeExpiredMediaBatch = async (db = pool) => {
  const cible = expiredMediaWhere();
  const [rows] = await db.execute(
    // Alias `m` obligatoire : `expiredMediaWhere()` qualifie ses colonnes
    // (`m.mediaUrl`, `m.sendAt`) pour rester utilisable dans une jointure.
    `SELECT m.msgID, m.mediaUrl FROM message m WHERE ${cible.sql} LIMIT ${BATCH_SIZE}`,
    cible.params,
  );
  if (rows.length === 0) return 0;

  for (const row of rows) {
    deleteMediaFile(row.mediaUrl);
  }

  const ids = rows.map((r) => r.msgID);
  await db.execute(
    `UPDATE message SET mediaUrl = NULL WHERE msgID IN (${ids.map(() => '?').join(',')})`,
    ids,
  );
  return rows.length;
};

/** Purge nocturne complète : traite tous les lots expirés, pas seulement le premier. */
const runNightlyMediaPurge = async (db = pool) => {
  let total = 0;
  let n;
  do {
    n = await purgeExpiredMediaBatch(db);
    total += n;
  } while (n === BATCH_SIZE);
  if (total) {
    console.log(`[Media] purge : ${total} fichier(s)`);
  }
  return { files: total };
};

module.exports = {
  expiredMediaWhere,
  purgeExpiredMediaBatch,
  runNightlyMediaPurge,
};
