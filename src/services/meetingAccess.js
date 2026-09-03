const pool = require('../config/db');

/**
 * Charge une réunion **et** la place de l'appelant dedans, en une requête.
 *
 * Séparé de `meetingAccessRules.js`, qui décide, et de `middleware/meetingAuth.js`,
 * qui traduit en codes HTTP. Cette découpe n'est pas décorative : le contrôle
 * d'appartenance doit servir aussi `meeting:join_room`, et une room socket n'a
 * pas de middleware Express. Un helper appelé des deux côtés est la seule forme
 * qui évite de réécrire la requête dans le handler — exactement la divergence
 * que l'en-tête de `groupAuth.js` dit vouloir empêcher.
 *
 * Le `LEFT JOIN` plutôt que deux requêtes : le contrôleur a besoin de la ligne,
 * pas d'un booléen. `joinMeeting` lit déjà `type_media` pour sa limite de
 * places, et lira `start_time`/`duree` quand la garde d'échéance arrivera. Les
 * poser dans `req.meetingAccess` épargne un aller-retour à chaque route.
 *
 * @param {number|string} idMeeting
 * @param {number} alanyaID  l'appelant, jamais une valeur venue du client
 * @param {{execute: Function}} [executor]  pour une connexion transactionnelle
 * @returns {Promise<{existe: boolean, idMeeting: number|null, idOrganiser: number|null,
 *   isEnd: boolean, typeMedia: number, duree: number, startTime: Date|null, room: string|null,
 *   estOrganisateur: boolean, estParticipant: boolean, participantStatus: number|null}>}
 */
const loadMeetingAccess = async (idMeeting, alanyaID, executor = pool) => {
  const [rows] = await executor.execute(
    `SELECT m.idMeeting, m.idOrganiser, m.isEnd, m.type_media, m.duree,
            m.start_time, m.room, p.status AS participantStatus,
            (p.ID IS NOT NULL) AS estParticipant,
            (DATE_ADD(m.start_time, INTERVAL m.duree MINUTE) < UTC_TIMESTAMP()) AS echue
       FROM meeting m
       LEFT JOIN participant p
         ON p.idMeeting = m.idMeeting AND p.IDparticipant = ?
      WHERE m.idMeeting = ?`,
    [alanyaID, idMeeting],
  );
  return _versAcces(rows, alanyaID);
};

/**
 * Même chose, résolue par code de salon.
 *
 * `mtg-<millisecondes>` est énumérable : c'est la route où le 404 indifférencié
 * compte le plus. Le filtre `isEnd = 0` et l'ordre sont ceux de
 * `getMeetingByRoom`, conservés pour ne rien changer au comportement légitime.
 */
const loadMeetingAccessByRoom = async (room, alanyaID, executor = pool) => {
  const [rows] = await executor.execute(
    `SELECT m.idMeeting, m.idOrganiser, m.isEnd, m.type_media, m.duree,
            m.start_time, m.room, p.status AS participantStatus,
            (p.ID IS NOT NULL) AS estParticipant,
            (DATE_ADD(m.start_time, INTERVAL m.duree MINUTE) < UTC_TIMESTAMP()) AS echue
       FROM meeting m
       LEFT JOIN participant p
         ON p.idMeeting = m.idMeeting AND p.IDparticipant = ?
      WHERE m.room = ? AND m.isEnd = 0
      ORDER BY m.start_time DESC
      LIMIT 1`,
    [alanyaID, room],
  );
  return _versAcces(rows, alanyaID);
};

const ABSENTE = Object.freeze({
  existe: false,
  idMeeting: null,
  idOrganiser: null,
  isEnd: false,
  typeMedia: 0,
  duree: 0,
  startTime: null,
  room: null,
  estOrganisateur: false,
  estParticipant: false,
  participantStatus: null,
  echue: false,
});

function _versAcces(rows, alanyaID) {
  if (!rows || rows.length === 0) return { ...ABSENTE };
  const r = rows[0];
  return {
    existe: true,
    idMeeting: Number(r.idMeeting),
    idOrganiser: Number(r.idOrganiser),
    isEnd: !!r.isEnd,
    typeMedia: Number(r.type_media) || 0,
    duree: Number(r.duree) || 0,
    startTime: r.start_time,
    room: r.room,
    estOrganisateur: Number(r.idOrganiser) === Number(alanyaID),
    estParticipant: !!Number(r.estParticipant),
    participantStatus: r.participantStatus == null ? null : Number(r.participantStatus),
    // Calculé en SQL contre `UTC_TIMESTAMP()` : `start_time` est écrit en UTC et
    // le pilote le rend dans le fuseau de la connexion. Comparer en JavaScript
    // demanderait de trancher cette ambiguïté ; le planificateur ne le fait pas
    // non plus.
    echue: !!Number(r.echue),
  };
}

module.exports = { loadMeetingAccess, loadMeetingAccessByRoom };
