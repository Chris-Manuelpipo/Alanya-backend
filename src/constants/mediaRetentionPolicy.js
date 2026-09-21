/**
 * Politique de rétention des fichiers média envoyés en message.
 *
 * Ce que ça borne : le stockage Backblaze, pas la copie locale sur le
 * téléphone. Passé ce délai le serveur répond `410 Gone` sur l'URL du média
 * (`middleware/mediaExpiry.js`) et les règles de cycle de vie du bucket
 * suppriment l'objet. La ligne `message`, elle, reste intacte : le message
 * n'est jamais supprimé. Un appareil qui avait déjà téléchargé le fichier
 * garde sa copie locale sans limite de durée — voir `chat_dao.dart`.
 *
 * ⚠ Cette valeur et les règles du bucket doivent rester accordées. Le serveur
 * déclare une partition du jour D expirée à D + 1 + R ; la règle Backblaze
 * doit donc masquer à R + 1 jours, jamais moins, sinon l'objet disparaît avant
 * que l'application ait annoncé son expiration. Voir
 * docs/conception/medias-backblaze.html.
 *
 * Réglage : variable d'environnement, comme TRIP_POINTS_RETENTION_H.
 */

const readInt = (name, defaultValue, { min, max }) => {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.min(max, Math.max(min, n));
};

const RETENTION = {
  // Tous types de médias confondus (image, vidéo, audio, fichier), et non
  // seulement ce qu'affiche « Mes médias » (qui, lui, ne montre que les images
  // et les vidéos).
  //
  // ⚠ VALEUR TEMPORAIRE — 365 jours depuis le 25/08/2026, au lieu des 30 jours
  // de la politique réelle. Ce dépôt n'a pas de base de développement séparée,
  // et un défaut à 30 jours ferait expirer d'un coup la quasi-totalité des
  // médias au premier démarrage d'un poste mal configuré. Le `.env` de la
  // production pose `MEDIA_RETENTION_DAYS=30`, et c'est de cette valeur-là que
  // se déduit la règle de cycle de vie du bucket.
  mediaDays: readInt('MEDIA_RETENTION_DAYS', 365, { min: 1, max: 365 }),
};

module.exports = { RETENTION };
