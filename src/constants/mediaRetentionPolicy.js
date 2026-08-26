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

const readBool = (name, defaultValue) => {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  return ['1', 'true', 'oui', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
};

const RETENTION = {
  // Tous types de médias confondus (image, vidéo, audio, fichier) : l'objectif
  // est de borner l'espace disque serveur, pas seulement ce qu'affiche
  // « Mes médias » (qui, lui, ne montre que images/vidéos).
  mediaDays: readInt('MEDIA_RETENTION_DAYS', 30, { min: 1, max: 365 }),
};

/**
 * Stockage partitionné par tranches de 24 heures (`utils/mediaPartition.js`).
 *
 * Remplace à terme la purge référentielle ci-dessus : au lieu de demander à
 * `message` quels fichiers sont expirés, on supprime le répertoire du jour
 * échu. La différence n'est pas de performance mais de garantie — un fichier
 * que la base ne référence pas (upload interrompu, conversation supprimée,
 * `unlink` en échec) tombe avec sa partition, alors que la purge
 * référentielle ne peut pas même le voir.
 */
const PARTITIONS = {
  // Interrupteur de bascule, ÉTEINT par défaut.
  //
  // Tant qu'il est à faux, les uploads continuent d'atterrir dans les dossiers
  // historiques et le balayage ne supprime rien : le code peut être déployé
  // sans rien changer au comportement. Ce dépôt n'ayant pas de base de
  // développement séparée (le `.env` local vise la production, cf. le délai
  // d'amorce du balayage de rétention dans server.js), un défaut « allumé »
  // ferait basculer la production à la première mise en service.
  enabled: readBool('MEDIA_PARTITIONS_ENABLED', false),

  // Cran d'arrêt : nombre maximal de partitions supprimées en une exécution.
  //
  // C'est le garde-fou contre le mode de défaillance catastrophique de ce
  // design. Le balayage décide à partir de l'horloge ; un saut NTP en avant
  // de plusieurs mois rendrait toutes les partitions échues d'un coup et
  // raserait la totalité des médias. Au-delà de ce seuil, le balayage refuse
  // d'agir et le signale, plutôt que d'obéir à une horloge folle.
  //
  // En régime établi il ne tombe qu'une partition par jour : toute exécution
  // qui en propose beaucoup plus est soit une reprise après une longue coupure,
  // soit une anomalie. Les deux méritent un accord explicite.
  maxDropsPerRun: readInt('MEDIA_PARTITIONS_MAX_DROPS', 10, { min: 1, max: 10000 }),

  // Âge à partir duquel une entrée de corbeille abandonnée par un autre
  // processus peut être adoptée puis effacée. Assez long pour ne jamais
  // arracher un `rm -rf` en cours à l'instance qui l'exécute.
  trashAdoptionMinutes: readInt('MEDIA_PARTITIONS_TRASH_ADOPT_MIN', 60, { min: 5, max: 1440 }),
};

module.exports = { RETENTION, PARTITIONS };
