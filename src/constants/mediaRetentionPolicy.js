/**
 * Politique de rétention des fichiers média envoyés en message.
 *
 * Ce que ça borne : l'espace disque du SERVEUR (`uploads/`), pas la copie
 * locale sur le téléphone. Une fois le fichier purgé côté serveur, la ligne
 * `message` reste intacte (le message n'est jamais supprimé) — seule
 * `mediaUrl` est vidée, exactement comme le fait déjà la consommation d'un
 * média « vue unique » (`messageController.js`, `markMessageViewed`). Un
 * appareil qui avait déjà téléchargé le fichier avant la purge garde sa copie
 * locale sans limite de durée : voir `chat_dao.dart` côté client.
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
  // Tous types de médias confondus (image, vidéo, audio, fichier) : l'objectif
  // est de borner l'espace disque serveur, pas seulement ce qu'affiche
  // « Mes médias » (qui, lui, ne montre que images/vidéos).
  mediaDays: readInt('MEDIA_RETENTION_DAYS', 30, { min: 1, max: 365 }),
};

module.exports = { RETENTION };
