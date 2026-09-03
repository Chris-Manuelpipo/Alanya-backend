const pool = require('../config/db');
const { balayable } = require('./meetingAccessRules');

/**
 * Fin de vie d'une réunion : le solde, et le balayage des réunions échues.
 *
 * `meeting:end` posait `isEnd = 1` et rien d'autre. Les présents restaient
 * `connecte = 1` **à vie**, sans durée : prévenu par `meeting:ended`, le client
 * part par `_terminateMeeting(emitLeave: false)` et n'appelle donc jamais
 * `POST /leave`. Conséquence visible : les pastilles vertes de l'écran de détail
 * ne s'éteignaient plus jamais, et aucune durée de participation n'était
 * enregistrée. Le départ individuel, lui, faisait déjà les deux — à la sortie
 * explicite (`handlers/meetings.js`) comme à l'expiration de la grâce
 * (`meetingWorkers.runMeetingDisconnectCascade`).
 *
 * D'où un écrivain unique, appelé par les quatre chemins qui terminent une
 * réunion : le socket `meeting:end`, le repli HTTP `PUT /meetings/:id`, l'arrêt
 * administrateur, et le balayage ci-dessous.
 */

/**
 * Marge après l'échéance avant qu'une réunion vide soit soldée.
 *
 * Une réunion déborde couramment de la durée annoncée à sa création, que
 * personne ne rallonge jamais. La marge évite aussi de solder quelqu'un qui se
 * trouve entre deux `join_room` — la grâce de déconnexion a pu remettre son
 * `connecte` à 0 pendant qu'il revient.
 */
const MARGE_MINUTES = 15;

/**
 * Solde une réunion : `isEnd = 1`, et toute ligne `participant` encore ouverte
 * reçoit son `connecte = 0` et sa durée.
 *
 * `GREATEST` plutôt qu'une écriture sèche : quatre appelants la déclenchent, et
 * une durée déjà calculée par un départ propre ne doit pas être réécrite à la
 * baisse. Le `WHERE connecte = 1` la rend en principe superflue ; elle ne coûte
 * rien et rend l'appel idempotent.
 *
 * `NOW()` et non `UTC_TIMESTAMP()` : `participant.start_time` est écrit par
 * `NOW()` dans `meeting:join_room`. Les deux bornes du `TIMESTAMPDIFF` doivent
 * venir du même référentiel — c'est le piège de ce fichier, `meeting.start_time`
 * étant lui en UTC.
 */
const solderMeeting = async (idMeeting, executor = pool) => {
  await executor.execute('UPDATE meeting SET isEnd = 1 WHERE idMeeting = ?', [idMeeting]);
  await executor.execute(
    `UPDATE participant
        SET connecte = 0,
            duree = GREATEST(duree, TIMESTAMPDIFF(SECOND, start_time, NOW()))
      WHERE idMeeting = ? AND connecte = 1`,
    [idMeeting],
  );
};

/**
 * Réunions candidates au solde : pas encore soldées, échéance dépassée de plus
 * de [MARGE_MINUTES], avec le nombre de participants encore connectés.
 *
 * Le tri fin est fait en JavaScript par [balayable] plutôt que dans un
 * `WHERE NOT EXISTS` : la règle qui protège une réunion vivante doit être une
 * fonction qu'on peut tester et neutraliser, pas une clause noyée dans une
 * chaîne SQL. Le surcoût est une lecture par minute sur une poignée de lignes.
 */
const candidatesEchues = async (executor = pool) => {
  const [rows] = await executor.execute(
    `SELECT m.idMeeting, m.isEnd,
            (SELECT COUNT(*) FROM participant p
              WHERE p.idMeeting = m.idMeeting AND p.connecte = 1) AS connectes
       FROM meeting m
      WHERE m.isEnd = 0
        AND DATE_ADD(m.start_time, INTERVAL (m.duree + ?) MINUTE) < UTC_TIMESTAMP()`,
    [MARGE_MINUTES],
  );
  return rows.map((r) => ({
    idMeeting: Number(r.idMeeting),
    isEnd: !!r.isEnd,
    echue: true,
    connectes: Number(r.connectes) || 0,
  }));
};

/**
 * Solde les réunions échues que plus personne n'occupe.
 *
 * **Ne diffuse rien.** Pas de `meeting:ended`, et pas d'`io` en paramètre : la
 * signature elle-même interdit la diffusion. Le balayage ne coupe personne, il
 * ne fait que refermer ce que plus personne n'occupe — sans quoi `isEnd` ne
 * serait jamais écrit ailleurs que par le geste explicite de l'organisateur, et
 * une réunion vieille de trois semaines resterait « en cours ».
 *
 * @returns {Promise<number>} nombre de réunions soldées.
 */
const balayer = async (executor = pool) => {
  const candidates = await candidatesEchues(executor);
  const aSolder = candidates.filter(balayable);
  for (const c of aSolder) {
    // eslint-disable-next-line no-await-in-loop
    await solderMeeting(c.idMeeting, executor);
  }
  if (candidates.length > 0) {
    console.log(
      `[MeetingClosure] ${candidates.length} réunion(s) échue(s), ${aSolder.length} soldée(s)`,
    );
  }
  return aSolder.length;
};

module.exports = { solderMeeting, candidatesEchues, balayer, MARGE_MINUTES };
