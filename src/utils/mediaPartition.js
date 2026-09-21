/**
 * Partitions de médias — arithmétique pure des tranches de 24 heures.
 *
 * La clé d'un média encode le jour de son dépôt :
 *
 *     media/<AAAA-MM-JJ>/<sous-dossier>/media_<alanyaID>_<epochMs>.<ext>
 *           └─ la partition
 *
 * Toute la conception tient dans cette ligne : **la date d'expiration est
 * dérivable de la clé**. Le serveur sait qu'une URL est morte sans consulter
 * la base ni appeler Backblaze, et la suppression n'a pas besoin de demander à
 * `message` quels médias sont encore référencés — ce sont les règles de cycle
 * de vie du bucket qui effacent, sur le seul critère de l'âge. C'est ce qui
 * borne réellement le stockage : un fichier jamais rattaché à un message
 * (envoi interrompu, conversation supprimée, suppression en échec) tombe comme
 * les autres, alors qu'une purge référentielle ne pouvait pas même le voir.
 *
 * Ce module ne fait aucune entrée-sortie et ne lit aucune variable
 * d'environnement : il calcule, il interprète, rien de plus. Les réglages sont
 * dans `constants/mediaRetentionPolicy.js`.
 *
 * ── Le fuseau ──
 * Les partitions sont découpées en **UTC**, jamais en heure locale. Le fuseau
 * du serveur peut changer (migration d'hébergeur, heure d'été) ; UTC ne bouge
 * pas. Une frontière de partition qui se déplace ferait expirer deux
 * partitions le même jour, ou aucune.
 */

/** Racine des médias de message, premier segment de la clé. */
const MEDIA_ROOT = 'media';

/**
 * Sous-dossiers par type de média, hérités de `middleware/upload.js`. Ils
 * restent nommés ici parce que les clés d'avant le découpage en tranches
 * (`media/<kind>/<fichier>`) vivent encore dans `message.mediaUrl` : le relais
 * de lecture doit pouvoir les reconnaître. Les noms de partition étant des
 * dates strictes, aucune collision n'est possible.
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
 * Préfixe de clé où déposer un nouveau média.
 * Exemple : `media/2026-08-24/images`.
 */
function partitionDirFor(kind, instant = Date.now()) {
  const cle = partitionKeyFor(instant);
  if (!cle) return null;
  return `${MEDIA_ROOT}/${cle}/${kind}`;
}

module.exports = {
  MEDIA_ROOT,
  LEGACY_KINDS,
  MS_PAR_JOUR,
  partitionKeyFor,
  isPartitionKey,
  partitionStartMs,
  partitionExpiresAtMs,
  isPartitionExpired,
  partitionFromPath,
  uploadMsFromFileName,
  partitionDirFor,
};
