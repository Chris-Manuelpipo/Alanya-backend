/**
 * Plages programmées du répondeur : une ou plusieurs périodes par jour.
 *
 * Remplace la fenêtre unique de la v1 (`startTime`/`endTime` + `daysBitmask`),
 * qui ne savait dire qu'une chose — la même tranche horaire, les jours cochés.
 *
 * Ce module ne connaît AUCUN fuseau. Il reçoit une heure murale déjà résolue
 * (`dayBit` + minutes depuis minuit) et répond. La résolution du fuseau vit dans
 * `voicemailScheduleService`, qui est le seul à la faire — deux implémentations
 * du même calendrier finiraient par diverger.
 */

const pool = require('../config/db');

/**
 * Trois plages par jour au maximum.
 *
 * Ce n'est pas une contrainte de schéma mais une limite de bon sens, tenue par
 * le contrôleur : au-delà, l'écran devient illisible et personne ne sait plus
 * quand son téléphone sonne — exactement ce que le répondeur doit éviter.
 */
const MAX_SLOTS_PER_DAY = 3;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/** `HH:MM[:SS]` → minutes depuis minuit. Rend 0 sur une entrée illisible. */
const timeToMinutes = (value) => {
  const parts = String(value || '').split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return h * 60 + m;
};

const normalizeTime = (value) => {
  if (value == null || value === '') return null;
  const match = String(value).trim().match(TIME_RE);
  if (!match) return null;
  return `${match[1]}:${match[2]}:${match[3] != null ? match[3] : '00'}`;
};

/** La veille de `dayBit`, dans la convention bit0 = lundi. */
const previousDayBit = (dayBit) => (dayBit + 6) % 7;

// ─────────────────────────────────────────────────────────────────────────────
//  Règles pures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Une plage couvre-t-elle cet instant ?
 *
 * Trois formes, et la troisième est celle qu'on oublie :
 *
 * — `start < end` : fenêtre ordinaire dans la journée, `[start, end)`.
 * — `start === end` : la journée entière. Un dimanche coché sans horaire veut
 *   dire « tout le dimanche », pas « zéro minute ».
 * — `start > end` : la fenêtre FRANCHIT MINUIT. (lundi, 22:00, 07:00) couvre
 *   lundi 22 h → mardi 7 h. Elle est donc active à deux moments distincts :
 *   le soir du jour de la plage, et le matin du LENDEMAIN. Le second cas ne se
 *   voit pas en regardant les plages du jour courant — il faut interroger
 *   celles de la veille. C'est `matchesAsPreviousDay` qui s'en charge.
 *
 * Borne basse incluse, borne haute exclue : une plage qui finit à 7 h laisse
 * sonner à 7 h 00.
 */
const matchesToday = (slot, minutes) => {
  const start = timeToMinutes(slot.startTime);
  const end = timeToMinutes(slot.endTime);
  if (start === end) return true;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start; // part du soir, avant minuit
};

/** La part APRÈS minuit d'une plage de la veille qui franchit minuit. */
const matchesAsPreviousDay = (slot, minutes) => {
  const start = timeToMinutes(slot.startTime);
  const end = timeToMinutes(slot.endTime);
  if (start <= end) return false; // ne franchit pas minuit : rien ne déborde
  return minutes < end;
};

/**
 * La plage active à cet instant, s'il y en a une.
 *
 * @param {Array} slots toutes les plages du compte, tous jours confondus
 * @param {{dayBit:number, minutes:number}} civil heure murale déjà résolue
 * @returns {{slot:object, endsTomorrow:boolean}|null} `endsTomorrow` dit si
 *   l'heure de fin tombe le lendemain de la date civile courante — ce dont a
 *   besoin l'appelant pour transformer une heure murale en instant absolu.
 */
const activeSlot = (slots, { dayBit, minutes }) => {
  const list = Array.isArray(slots) ? slots : [];

  // Les plages du jour d'abord : c'est le cas courant, et la part « soir » d'une
  // plage à cheval en fait partie.
  for (const slot of list) {
    if (Number(slot.dayBit) !== dayBit) continue;
    if (!matchesToday(slot, minutes)) continue;
    const start = timeToMinutes(slot.startTime);
    const end = timeToMinutes(slot.endTime);
    // Journée entière : aucune heure de fin à annoncer dans la journée.
    if (start === end) return { slot, endsTomorrow: false, allDay: true };
    return { slot, endsTomorrow: start > end, allDay: false };
  }

  // Puis la queue d'une plage d'hier qui a franchi minuit.
  const hier = previousDayBit(dayBit);
  for (const slot of list) {
    if (Number(slot.dayBit) !== hier) continue;
    if (!matchesAsPreviousDay(slot, minutes)) continue;
    // On est déjà après minuit : la fin tombe aujourd'hui.
    return { slot, endsTomorrow: false, allDay: false };
  }

  return null;
};

/** Raccourci booléen pour les appelants qui ne veulent pas la plage. */
const isAnySlotActive = (slots, civil) => activeSlot(slots, civil) != null;

// ─────────────────────────────────────────────────────────────────────────────
//  Accès base
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Les plages d'un compte.
 *
 * Table absente (migration 088 pas encore posée) → aucune plage. Même règle que
 * partout ailleurs dans ce service : une base incomplète ne doit couper aucun
 * appel, le défaut penche toujours du côté « le téléphone sonne ».
 */
const loadSlots = async (alanyaID) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, dayBit, startTime, endTime
         FROM user_voicemail_slot
        WHERE alanyaID = ?
        ORDER BY dayBit, startTime`,
      [alanyaID],
    );
    return rows;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return [];
    throw e;
  }
};

/**
 * Remplace TOUTES les plages d'un compte.
 *
 * Remplacement complet et non différentiel : l'écran envoie l'état qu'il veut
 * voir, et une écriture partielle demanderait au client de suivre des
 * identifiants de lignes qu'il n'a aucune raison de connaître. En transaction,
 * parce qu'un compte à qui il resterait la moitié de ses plages serait pire
 * qu'un compte qui n'en a plus.
 */
const replaceSlots = async (alanyaID, slots = []) => {
  const propres = [];
  const parJour = new Map();

  for (const brut of slots) {
    const dayBit = Number(brut.dayBit);
    if (!Number.isInteger(dayBit) || dayBit < 0 || dayBit > 6) {
      throw new Error('dayBit invalide (attendu un entier entre 0 et 6)');
    }
    const startTime = normalizeTime(brut.startTime);
    const endTime = normalizeTime(brut.endTime);
    if (startTime == null || endTime == null) {
      throw new Error('Format horaire invalide (attendu HH:MM ou HH:MM:SS)');
    }
    const n = (parJour.get(dayBit) || 0) + 1;
    if (n > MAX_SLOTS_PER_DAY) {
      throw new Error(`Trois plages par jour au maximum`);
    }
    parJour.set(dayBit, n);
    propres.push({ dayBit, startTime, endTime });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('DELETE FROM user_voicemail_slot WHERE alanyaID = ?', [alanyaID]);
    for (const s of propres) {
      await conn.execute(
        `INSERT INTO user_voicemail_slot (alanyaID, dayBit, startTime, endTime)
         VALUES (?, ?, ?, ?)`,
        [alanyaID, s.dayBit, s.startTime, s.endTime],
      );
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  return loadSlots(alanyaID);
};

module.exports = {
  MAX_SLOTS_PER_DAY,
  timeToMinutes,
  normalizeTime,
  previousDayBit,
  matchesToday,
  matchesAsPreviousDay,
  activeSlot,
  isAnySlotActive,
  loadSlots,
  replaceSlots,
};
