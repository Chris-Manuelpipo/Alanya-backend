/**
 * Partitions de médias — arithmétique pure des tranches de 24 heures.
 *
 * Le chemin d'un média encode le jour de son upload :
 *
 *     uploads/media/<AAAA-MM-JJ>/<sous-dossier>/media_<alanyaID>_<epochMs>.<ext>
 *                   └─ la partition
 *
 * Toute la conception tient dans cette ligne : **la date d'expiration est
 * dérivable du chemin**. Le serveur sait qu'une URL est morte sans consulter la
 * base ni toucher au disque, et la suppression se fait en retirant un
 * répertoire entier — jamais en demandant à `message` quels fichiers sont
 * encore référencés. C'est ce qui borne réellement l'espace disque : un fichier
 * jamais rattaché à un message (upload interrompu, conversation supprimée,
 * `unlink` en échec) tombe avec sa partition comme les autres, alors que la
 * purge référentielle ne pouvait pas même le voir.
 *
 * Ce module ne fait aucune entrée-sortie et ne lit aucune variable
 * d'environnement : il calcule, il interprète, rien de plus. Les réglages sont
 * dans `constants/mediaRetentionPolicy.js`, les effets dans
 * `services/mediaPartitions.js`.
 *
 * ── Le fuseau ──
 * Les partitions sont découpées en **UTC**, jamais en heure locale. Le fuseau
 * du serveur peut changer (migration d'hébergeur, heure d'été) ; UTC ne bouge
 * pas. Une frontière de partition qui se déplace ferait tomber deux partitions
 * le même jour, ou aucune.
 */

/** Racine des médias de message, relative au dossier `uploads/`. */
const MEDIA_ROOT = 'media';

/**
 * Sas de suppression. Une partition échue y est déplacée par `rename` avant
 * d'être effacée : elle quitte l'espace servi en un seul appel système, et le
 * `rm -rf` — qui peut durer plusieurs minutes sur des dizaines de gigaoctets —
 * se fait hors du chemin critique. Le nom commence par un point pour qu'il ne
 * puisse jamais être confondu avec une partition (`isPartitionKey` le rejette
 * de toute façon).
 */
const TRASH_DIR = '.trash';

/**
 * Sous-dossiers par type de média, hérités de `middleware/upload.js`. Ils sont
 * listés ici parce que `readdir(uploads/media)` renvoie, pendant toute la
 * transition, un mélange de partitions et de ces quatre dossiers historiques :
 * il faut pouvoir distinguer les deux sans se tromper. Les noms de partition
 * étant des dates strictes, aucune collision n'est possible.
 */
const LEGACY_KINDS = ['images', 'audio', 'video', 'files'];

/** `AAAA-MM-JJ`, strict : 4 chiffres, 2, 2. */
const PARTITION_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Nom de fichier d'upload : `media_<alanyaID>_<epochMs>.<ext>`.
 * L'horodatage y est présent depuis l'origine (`middleware/upload.js`), ce qui
 * rend la partition d'un fichier existant calculable **sans la base** — c'est
 * ce qui rend la migration des fichiers déjà en place déterministe et
 * rejouable. Le script de restauration du 25/08/2026 exploite la même
 * convention.
 */
const UPLOAD_NAME_RE = /^media_(\d+)_(\d{10,17})(?:\.[^.]+)?$/;

const MS_PAR_JOUR = 24 * 60 * 60 * 1000;

/** Deux chiffres, pour la composition des clés. */
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Clé de partition d'un instant donné (millisecondes epoch, ou `Date`).
 * Renvoie `null` sur une entrée non finie plutôt que la chaîne `NaN-NaN-NaN` :
 * un appelant qui se trompe doit échouer visiblement, pas écrire dans un
 * répertoire au nom absurde qui ne serait jamais balayé.
 */
function partitionKeyFor(instant) {
  const ms = instant instanceof Date ? instant.getTime() : Number(instant);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * `true` si `nom` est une clé de partition valide — forme ET date réelle.
 * Le contrôle de réalité compte : `2026-02-31` a la bonne forme, mais laisser
 * passer une date inexistante ferait entrer dans le calcul d'expiration une
 * valeur que `Date.UTC` normaliserait silencieusement vers un autre jour.
 */
function isPartitionKey(nom) {
  const m = PARTITION_RE.exec(String(nom || ''));
  if (!m) return false;
  const [, a, mo, j] = m.map(Number);
  if (mo < 1 || mo > 12 || j < 1 || j > 31) return false;
  const t = Date.UTC(a, mo - 1, j);
  const d = new Date(t);
  return d.getUTCFullYear() === a && d.getUTCMonth() === mo - 1 && d.getUTCDate() === j;
}

/** Minuit UTC ouvrant la partition, en millisecondes. `null` si la clé est invalide. */
function partitionStartMs(cle) {
  if (!isPartitionKey(cle)) return null;
  const [, a, mo, j] = PARTITION_RE.exec(cle).map(Number);
  return Date.UTC(a, mo - 1, j);
}

/**
 * Instant à partir duquel la partition peut tomber.
 *
 * Une partition `D` contient les uploads de `[D 00:00Z, D+1 00:00Z)`. Le plus
 * récent de ses fichiers a donc été déposé juste avant `D+1 00:00Z`, et doit
 * vivre au moins `retentionDays`. La partition n'est donc effaçable qu'à
 * `D + 1 jour + retentionDays`.
 *
 * Conséquence assumée : la rétention réelle d'un fichier tombe dans
 * `[retentionDays, retentionDays + 1 jour]` selon son heure d'upload. L'écart
 * joue toujours en faveur de l'utilisateur — la politique s'énonce « au moins
 * 30 jours », jamais « exactement 30 jours ».
 */
function partitionExpiresAtMs(cle, retentionDays) {
  const debut = partitionStartMs(cle);
  if (debut === null) return null;
  const jours = Number(retentionDays);
  if (!Number.isFinite(jours)) return null;
  return debut + (jours + 1) * MS_PAR_JOUR;
}

/**
 * `true` si la partition a dépassé sa rétention et peut être supprimée.
 * `now` est injectable pour que les tests n'aient pas à voyager dans le temps.
 */
function isPartitionExpired(cle, { retentionDays, now = Date.now() } = {}) {
  const echeance = partitionExpiresAtMs(cle, retentionDays);
  if (echeance === null) return false;
  return now >= echeance;
}

/**
 * Secondes restantes avant la chute de la partition, plancher à 0.
 *
 * Sert à plafonner le `max-age` des réponses HTTP. Les fichiers d'upload sont
 * immuables, d'où le `Cache-Control: immutable` d'origine — mais une URL qui
 * meurt dans trois jours ne doit pas être gardée un an par un cache
 * intermédiaire, sinon le 410 n'atteint jamais le client.
 */
function secondsUntilPartitionExpiry(cle, { retentionDays, now = Date.now() } = {}) {
  const echeance = partitionExpiresAtMs(cle, retentionDays);
  if (echeance === null) return 0;
  return Math.max(0, Math.floor((echeance - now) / 1000));
}

/**
 * Extrait la clé de partition d'un chemin ou d'une URL de média.
 *
 * Reconnaît les deux dispositions, parce qu'elles coexistent pendant toute la
 * transition :
 *   - partitionnée : `.../uploads/media/2026-08-24/images/media_1_….jpg`
 *   - héritée      : `.../uploads/media/images/media_1_….jpg` → `null`
 *
 * `null` ne veut donc pas dire « expiré » mais « hors partition » : avatars,
 * anciens chemins, tout ce que le balayage ne regarde pas. L'appelant décide
 * quoi en faire — le middleware de lecture le passe au relais hérité.
 */
function partitionFromPath(chemin) {
  if (!chemin) return null;
  const s = String(chemin).split('?')[0].split('#')[0];
  const marqueur = `/${MEDIA_ROOT}/`;
  const i = s.indexOf(marqueur);
  if (i === -1) return null;
  const segment = s.slice(i + marqueur.length).split('/')[0];
  return isPartitionKey(segment) ? segment : null;
}

/**
 * Horodatage d'upload lu dans le nom du fichier, en millisecondes.
 *
 * `null` si le nom ne suit pas la convention — un fichier importé à la main, un
 * avatar, un reliquat. La migration des fichiers existants retombe alors sur
 * `mtime`, moins fiable mais suffisant pour un cas résiduel.
 */
function uploadMsFromFileName(nom) {
  const m = UPLOAD_NAME_RE.exec(String(nom || ''));
  if (!m) return null;
  const ms = Number(m[2]);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * Chemin relatif à `uploads/` où déposer un nouveau média.
 * Exemple : `media/2026-08-24/images`.
 */
function partitionDirFor(kind, instant = Date.now()) {
  const cle = partitionKeyFor(instant);
  if (!cle) return null;
  return `${MEDIA_ROOT}/${cle}/${kind}`;
}

/**
 * Nom du répertoire de corbeille pour une partition réclamée.
 *
 * Le nom porte le worker et l'exécution parce que **le verrou réel du balayage
 * est `rename(2)`, pas le bail en base**. `rename` étant atomique, deux
 * instances qui décident simultanément de faire tomber la même partition
 * aboutissent à une seule réussite, l'autre recevant `ENOENT` — qui se traite
 * comme « quelqu'un d'autre l'a prise », pas comme une erreur. Le suffixe
 * unique garantit qu'elles ne se disputent jamais la même destination, et il
 * permet ensuite à chacune de n'effacer que ce qu'elle a réclamé.
 */
function trashNameFor(cle, workerId, runId) {
  return `${cle}__${sanitizeIdPart(workerId)}__${sanitizeIdPart(runId)}`;
}

/**
 * Réduit un identifiant à ce qui peut tenir dans un nom de répertoire.
 *
 * Le point est exclu de la liste blanche, pas seulement la barre oblique : un
 * `..` résiduel n'aurait pas permis de sortir du sas, mais un nom de répertoire
 * contenant une séquence de remontée n'a aucune raison d'exister.
 *
 * Exporté parce que la comparaison « cette entrée de corbeille est-elle la
 * mienne ? » doit appliquer exactement la même transformation que la
 * composition du nom — deux recettes distinctes finiraient par diverger, et
 * une instance n'effacerait plus ses propres réclamations.
 */
function sanitizeIdPart(v) {
  return String(v || 'inconnu').replace(/[^A-Za-z0-9_-]/g, '-');
}

/** Décompose un nom de corbeille. `null` si le nom ne vient pas de `trashNameFor`. */
function parseTrashName(nom) {
  const parts = String(nom || '').split('__');
  if (parts.length !== 3) return null;
  const [cle, workerId, runId] = parts;
  if (!isPartitionKey(cle)) return null;
  return { cle, workerId, runId };
}

module.exports = {
  MEDIA_ROOT,
  TRASH_DIR,
  LEGACY_KINDS,
  MS_PAR_JOUR,
  partitionKeyFor,
  isPartitionKey,
  partitionStartMs,
  partitionExpiresAtMs,
  isPartitionExpired,
  secondsUntilPartitionExpiry,
  partitionFromPath,
  uploadMsFromFileName,
  partitionDirFor,
  trashNameFor,
  parseTrashName,
  sanitizeIdPart,
};
