/**
 * Planification du répondeur : lecture, écriture, et la seule question qui
 * compte côté appel — « à cet instant, cet utilisateur reçoit-il encore ses
 * appels ? »
 *
 * La FORME du créneau est celle de `dndScheduleService` (migration 033) :
 * `enabled` + `startTime`/`endTime` + `daysBitmask` avec bit0=lundi. C'est un
 * modèle éprouvé, et l'utilisateur règle les deux écrans de la même façon.
 *
 * Deux choses en diffèrent, et ce ne sont pas des détails.
 *
 * 1. L'HEURE. `isDndActive` évalue avec `now.getHours()`, c'est-à-dire l'heure
 *    locale du SERVEUR. Décaler une notification d'une heure se pardonne ;
 *    décider qu'un téléphone ne sonnera pas, non. On évalue donc dans le fuseau
 *    du compte, résolu par la cascade de `resolveTimezone`.
 *
 * 2. L'ÉCHÉANCE. `untilAt` porte l'activation ponctuelle, et elle est toujours
 *    datée : il n'existe aucun mode « actif jusqu'à nouvel ordre ». C'est un
 *    instant ABSOLU (le pool est en `timezone: 'Z'`), calculé sur l'appareil et
 *    envoyé en UTC — ce chemin-là ne dépend donc d'aucun fuseau.
 */

const pool = require('../config/db');

const DEFAULT_SCHEDULE = Object.freeze({
  enabled: 0,
  startTime: '22:00:00',
  endTime: '07:00:00',
  daysBitmask: 127,
  untilAt: null,
  timezone: null,
  bypassListId: null,
});

/** Dernier recours de la cascade : le fuseau du marché principal. */
const FALLBACK_TIMEZONE = 'Africa/Douala';

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

// ─────────────────────────────────────────────────────────────────────────────
//  Fuseau
// ─────────────────────────────────────────────────────────────────────────────

/** Vrai si `Intl` accepte cet identifiant — le seul juge qui compte ici. */
const isValidTimezone = (tz) => {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch (_) {
    return false;
  }
};

/**
 * La cascade : ce que l'appareil a posé, sinon le pays du compte, sinon le
 * serveur, sinon le marché principal.
 *
 * `pays.timeZone` contient de vrais identifiants IANA et est déjà joint par
 * compte dans tout le backend — c'est le choix documenté par la migration 017.
 * Un fuseau invalide (donnée héritée, pays mal renseigné) est ignoré sans
 * jeter : une planification illisible ne doit jamais faire échouer un appel.
 */
const resolveTimezone = ({ scheduleTimezone, countryTimezone } = {}) => {
  if (isValidTimezone(scheduleTimezone)) return scheduleTimezone;
  if (isValidTimezone(countryTimezone)) return countryTimezone;
  if (isValidTimezone(process.env.TZ)) return process.env.TZ;
  return FALLBACK_TIMEZONE;
};

/**
 * L'heure murale dans un fuseau, décomposée.
 *
 * Deux pièges silencieux sont désamorcés ici :
 *
 * — `hour` peut valoir `'24'` à minuit pile selon l'implémentation ICU, avec
 *   `hour12: false`. Non ramené modulo 24, il décale l'évaluation d'un jour
 *   entier, une minute par nuit.
 *
 * — le jour de la semaine ne doit JAMAIS être lu dans un nom de jour localisé
 *   (`weekday: 'short'`), qui dépend de la locale et des données ICU
 *   disponibles. On le dérive de la date civile via `Date.UTC`, qui est
 *   invariant.
 */
const civilPartsInZone = (date, timeZone) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );

  const y = Number(parts.year);
  const m = Number(parts.month);
  const d = Number(parts.day);
  const h = Number(parts.hour) % 24;
  const mi = Number(parts.minute);
  const s = Number(parts.second);
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

  return { y, m, d, h, mi, s, minutes: h * 60 + mi, dayBit: jsDay === 0 ? 6 : jsDay - 1 };
};

/** `YYYY-MM-DD` dans le fuseau donné — la clé de journée du plafond quotidien. */
const civilDayKey = (date, timeZone) => {
  const c = civilPartsInZone(date, timeZone);
  return `${c.y}-${String(c.m).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`;
};

/** Décalage du fuseau, en minutes, à cet instant précis. */
const _offsetMinutesAt = (date, timeZone) => {
  const c = civilPartsInZone(date, timeZone);
  const asUtc = Date.UTC(c.y, c.m - 1, c.d, c.h, c.mi, c.s);
  return Math.round((asUtc - date.getTime()) / 60000);
};

/**
 * Une heure murale → l'instant absolu correspondant.
 *
 * Deux passes : la première utilise le décalage d'aujourd'hui, la seconde le
 * corrige si l'échéance tombe de l'autre côté d'un changement d'heure. Sans la
 * seconde, le bandeau disparaîtrait une heure trop tôt ou trop tard deux nuits
 * par an — visible, et impossible à reproduire le reste de l'année.
 */
const _wallToInstant = (y, m, d, hour, minute, timeZone) => {
  const naive = Date.UTC(y, m - 1, d, hour, minute);
  const premier = _offsetMinutesAt(new Date(naive), timeZone);
  let instant = naive - premier * 60000;
  const second = _offsetMinutesAt(new Date(instant), timeZone);
  if (second !== premier) instant = naive - second * 60000;
  return new Date(instant);
};

// ─────────────────────────────────────────────────────────────────────────────
//  Règles pures
// ─────────────────────────────────────────────────────────────────────────────

const timeToMinutes = (value) => {
  const parts = String(value || '').split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
};

const _untilInstant = (schedule) => {
  if (schedule?.untilAt == null) return null;
  const t = new Date(schedule.untilAt);
  return Number.isNaN(t.getTime()) ? null : t;
};

/** L'activation ponctuelle court-elle encore ? Comparaison d'instants, sans fuseau. */
const isUntilActive = (schedule, now = new Date()) => {
  const until = _untilInstant(schedule);
  return until != null && until.getTime() > now.getTime();
};

/**
 * La règle récurrente couvre-t-elle cet instant ?
 *
 * Sémantique reprise telle quelle de `isDndActive`, y compris pour la fenêtre
 * qui franchit minuit : le bit testé est TOUJOURS celui du jour courant. Une
 * fenêtre 22 h–7 h réglée du lundi au vendredi couvre donc le vendredi de 22 h
 * à minuit, puis s'arrête — le samedi matin n'est pas coché. C'est déjà le
 * comportement du « Ne pas déranger », et deux écrans qui se ressemblent
 * doivent se comporter pareil.
 */
const isRecurringActive = (schedule, now = new Date(), timeZone = FALLBACK_TIMEZONE) => {
  if (!schedule?.enabled) return false;

  const mask = Number(schedule.daysBitmask);
  if (!Number.isInteger(mask) || mask === 0) return false;

  const { dayBit, minutes } = civilPartsInZone(now, timeZone);
  if ((mask & (1 << dayBit)) === 0) return false;

  const start = timeToMinutes(schedule.startTime);
  const end = timeToMinutes(schedule.endTime);

  if (start === end) return true; // journée entière
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
};

/** Le répondeur intercepte-t-il, à cet instant ? */
const isVoicemailActive = (schedule, now = new Date(), timeZone = FALLBACK_TIMEZONE) =>
  isUntilActive(schedule, now) || isRecurringActive(schedule, now, timeZone);

/**
 * Jusqu'à quand, en instant absolu — ce que le bandeau affiche et ce sur quoi
 * le client arme son minuteur pour se masquer tout seul.
 *
 * `null` veut dire « actif, mais sans échéance calculable » : c'est le cas
 * `startTime === endTime` (journée entière, qui recommence chaque jour coché).
 * Le bandeau affiche alors « Répondeur actif » sans heure, plutôt qu'une
 * échéance inventée.
 */
const activeUntil = (schedule, now = new Date(), timeZone = FALLBACK_TIMEZONE) => {
  const candidats = [];

  if (isUntilActive(schedule, now)) candidats.push(_untilInstant(schedule));

  if (isRecurringActive(schedule, now, timeZone)) {
    const start = timeToMinutes(schedule.startTime);
    const end = timeToMinutes(schedule.endTime);
    if (start === end) return null; // aucune fin dans la journée

    const c = civilPartsInZone(now, timeZone);
    // Fenêtre qui franchit minuit et qu'on aborde avant minuit : la fin est
    // demain. Dans tous les autres cas, l'heure de fin est encore devant nous
    // aujourd'hui.
    const demain = start > end && c.minutes >= start;
    candidats.push(
      _wallToInstant(
        c.y,
        c.m,
        c.d + (demain ? 1 : 0),
        Math.floor(end / 60),
        end % 60,
        timeZone,
      ),
    );
  }

  if (candidats.length === 0) return null;
  // Les deux peuvent courir en même temps : c'est la plus lointaine qui décide.
  return new Date(Math.max(...candidats.map((d) => d.getTime())));
};

// ─────────────────────────────────────────────────────────────────────────────
//  Accès base
// ─────────────────────────────────────────────────────────────────────────────

const _normalizeTime = (value, fallback) => {
  if (value == null || value === '') return fallback;
  const match = String(value).trim().match(TIME_RE);
  if (!match) return null;
  return `${match[1]}:${match[2]}:${match[3] != null ? match[3] : '00'}`;
};

/**
 * Le créneau d'un compte, fuseau résolu compris.
 *
 * La requête part de `users` et non de `user_voicemail_schedule` : un compte
 * sans ligne de planification doit quand même rendre son fuseau de pays, sans
 * quoi la cascade perdrait son deuxième étage pour tout le monde au premier
 * jour.
 *
 * Table absente (migration pas encore posée) → répondeur inactif. Une base
 * incomplète ne doit couper aucun appel : le défaut penche toujours du côté
 * « le téléphone sonne ».
 */
const loadUserVoicemailSchedule = async (alanyaID) => {
  let row = null;
  try {
    const [rows] = await pool.execute(
      `SELECT v.enabled, v.startTime, v.endTime, v.daysBitmask,
              v.untilAt, v.timezone, v.bypassListId,
              p.timeZone AS countryTimezone
         FROM users u
         LEFT JOIN user_voicemail_schedule v ON v.alanyaID = u.alanyaID
         LEFT JOIN pays p ON p.idPays = u.idPays
        WHERE u.alanyaID = ?`,
      [alanyaID],
    );
    row = rows[0] || null;
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
  }

  if (!row) return { ...DEFAULT_SCHEDULE, resolvedTimezone: resolveTimezone({}) };

  // `enabled` est NULL quand la jointure n'a trouvé aucune ligne : c'est un
  // compte sans planification, pas une planification vide.
  const schedule = row.enabled == null
    ? { ...DEFAULT_SCHEDULE }
    : {
        enabled: row.enabled ? 1 : 0,
        startTime: row.startTime,
        endTime: row.endTime,
        daysBitmask: Number(row.daysBitmask),
        untilAt: row.untilAt,
        timezone: row.timezone,
        bypassListId: row.bypassListId,
      };

  return {
    ...schedule,
    resolvedTimezone: resolveTimezone({
      scheduleTimezone: schedule.timezone,
      countryTimezone: row.countryTimezone,
    }),
  };
};

const upsertUserVoicemailSchedule = async (alanyaID, patch = {}) => {
  const current = await loadUserVoicemailSchedule(alanyaID);
  const next = { ...current, ...patch };

  const startTime = _normalizeTime(next.startTime, DEFAULT_SCHEDULE.startTime);
  const endTime = _normalizeTime(next.endTime, DEFAULT_SCHEDULE.endTime);
  if (startTime == null || endTime == null) {
    throw new Error('Format horaire invalide (attendu HH:MM ou HH:MM:SS)');
  }

  const daysBitmask = Number(next.daysBitmask);
  if (!Number.isInteger(daysBitmask) || daysBitmask < 0 || daysBitmask > 127) {
    throw new Error('daysBitmask doit être un entier entre 0 et 127');
  }

  let untilAt = null;
  if (next.untilAt != null && next.untilAt !== '') {
    const t = new Date(next.untilAt);
    if (Number.isNaN(t.getTime())) throw new Error('untilAt invalide (attendu une date ISO)');
    untilAt = t;
  }

  if (next.timezone != null && next.timezone !== '' && !isValidTimezone(next.timezone)) {
    throw new Error('timezone invalide (attendu un identifiant IANA)');
  }
  const timezone = next.timezone == null || next.timezone === '' ? null : next.timezone;

  const bypassListId = next.bypassListId == null || next.bypassListId === ''
    ? null
    : Number(next.bypassListId);
  if (bypassListId != null && !Number.isInteger(bypassListId)) {
    throw new Error('bypassListId invalide');
  }

  await pool.execute(
    `INSERT INTO user_voicemail_schedule
       (alanyaID, enabled, startTime, endTime, daysBitmask, untilAt, timezone, bypassListId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       enabled      = VALUES(enabled),
       startTime    = VALUES(startTime),
       endTime      = VALUES(endTime),
       daysBitmask  = VALUES(daysBitmask),
       untilAt      = VALUES(untilAt),
       timezone     = VALUES(timezone),
       bypassListId = VALUES(bypassListId),
       updatedAt    = NOW()`,
    [
      alanyaID,
      next.enabled ? 1 : 0,
      startTime,
      endTime,
      daysBitmask,
      untilAt,
      timezone,
      bypassListId,
    ],
  );

  return loadUserVoicemailSchedule(alanyaID);
};

/**
 * Cet appelant fait-il partie de la liste autorisée à faire sonner ?
 *
 * Lecture de clé primaire sur `contact_list_member` — c'est ce qui justifie de
 * n'accepter qu'UNE liste : le contrôle reste gratuit dans le chemin critique
 * de `call_user`.
 */
const isCallerAllowedToRing = async (bypassListId, callerID) => {
  if (bypassListId == null || callerID == null) return false;
  try {
    const [rows] = await pool.execute(
      'SELECT 1 FROM contact_list_member WHERE idList = ? AND idFriend = ? LIMIT 1',
      [bypassListId, callerID],
    );
    return rows.length > 0;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return false;
    throw e;
  }
};

/**
 * La décision, pour un appel entrant : faut-il intercepter ?
 *
 * Point d'entrée unique de `call_user`, pour qu'il n'ait pas à réordonner
 * lui-même les trois questions. La liste d'exception n'est interrogée que si le
 * répondeur est par ailleurs actif : une requête de moins sur l'écrasante
 * majorité des appels, qui n'en déclenchent aucun.
 */
const shouldInterceptCall = async (targetID, callerID, now = new Date()) => {
  const schedule = await loadUserVoicemailSchedule(targetID);
  if (!isVoicemailActive(schedule, now, schedule.resolvedTimezone)) {
    return { intercept: false, schedule };
  }
  if (await isCallerAllowedToRing(schedule.bypassListId, callerID)) {
    return { intercept: false, schedule, bypassed: true };
  }
  return {
    intercept: true,
    schedule,
    activeUntil: activeUntil(schedule, now, schedule.resolvedTimezone),
  };
};

module.exports = {
  DEFAULT_SCHEDULE,
  FALLBACK_TIMEZONE,
  isValidTimezone,
  resolveTimezone,
  civilPartsInZone,
  civilDayKey,
  timeToMinutes,
  isUntilActive,
  isRecurringActive,
  isVoicemailActive,
  activeUntil,
  loadUserVoicemailSchedule,
  upsertUserVoicemailSchedule,
  isCallerAllowedToRing,
  shouldInterceptCall,
  _normalizeTime,
  _wallToInstant,
};
