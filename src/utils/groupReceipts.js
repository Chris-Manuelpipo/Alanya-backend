const pool = require('../config/db');

/**
 * Accusés de réception et de lecture PAR MEMBRE, dans les groupes (migration 096).
 *
 * En groupe, `message.status` ne garde qu'un statut pour tous : le premier membre
 * qui lit le fait passer à « lu », et les doubles coches bleues de l'expéditeur
 * s'allument (comportement GARDÉ, décision produit). Ce module tient à côté un
 * repère par membre (`conv_participants.lastDeliveredMsgID / lastReadMsgID`) et
 * le journal de ses avancées (`conv_receipt_log`), d'où se déduisent :
 *   - le statut d'un message du point de vue de chaque membre, pour que son
 *     compteur de non-lus reste juste (groupe 3GI 2029, bug A6) ;
 *   - qui a reçu, qui a lu et à quelle heure (écran « Infos du message »).
 */

const KIND_DELIVERED = 2;
const KIND_READ = 3;

const COLONNES = {
  [KIND_DELIVERED]: { msg: 'lastDeliveredMsgID', at: 'lastDeliveredAt' },
  [KIND_READ]: { msg: 'lastReadMsgID', at: 'lastReadAt' },
};

/**
 * Avance le repère [kind] de [alanyaID] jusqu'au dernier message du groupe, et
 * journalise l'avancée. Sans effet hors groupe, ou si le repère est déjà au bout.
 *
 * En groupe, la lecture compte même quand le membre a désactivé ses accusés de
 * lecture (comme WhatsApp) : c'est à l'appelant de ne pas filtrer.
 *
 * @returns {Promise<{isGroup: boolean, advanced: boolean, upTo?: number}>}
 */
const avancerRepereGroupe = async ({ conversationID, alanyaID, kind, isGroup, db = pool }) => {
  const colonnes = COLONNES[kind];
  if (!colonnes) throw new Error(`kind inconnu: ${kind}`);

  // [isGroup] évite de relire la conversation quand l'appelant le sait déjà.
  let groupe = isGroup;
  if (groupe === undefined) {
    const [[conv]] = await db.execute(
      'SELECT isGroup FROM conversation WHERE conversID = ?',
      [conversationID],
    );
    groupe = !!conv && Number(conv.isGroup) === 1;
  }
  if (!groupe) return { isGroup: false, advanced: false };

  const [[dernier]] = await db.execute(
    'SELECT MAX(msgID) AS maxID FROM message WHERE conversationID = ?',
    [conversationID],
  );
  const upTo = Number(dernier?.maxID) || 0;
  if (!upTo) return { isGroup: true, advanced: false };

  const [res] = await db.execute(
    `UPDATE conv_participants SET ${colonnes.msg} = ?, ${colonnes.at} = NOW()
     WHERE conversID = ? AND alanyaID = ? AND COALESCE(${colonnes.msg}, 0) < ?`,
    [upTo, conversationID, alanyaID, upTo],
  );
  if ((res?.affectedRows ?? 0) === 0) return { isGroup: true, advanced: false, upTo };

  await db.execute(
    `INSERT INTO conv_receipt_log (conversID, alanyaID, kind, upToMsgID, at)
     VALUES (?, ?, ?, ?, NOW())`,
    [conversationID, alanyaID, kind, upTo],
  );
  return { isGroup: true, advanced: true, upTo };
};

/**
 * Statut d'un message tel que le voit [lecteurID].
 *
 * Hors groupe, ou pour ses propres messages, c'est `message.status`. Pour un
 * message de groupe reçu, c'est « lu » s'il est sous le repère de lecture du
 * lecteur, sinon au plus « reçu » — même si un autre membre l'a déjà lu.
 * Repère inconnu (`null` : membre arrivé avant la migration sans remplissage,
 * ou ajouté depuis sans avoir encore rien lu) : statut brut, comme avant.
 */
const statutPourLecteur = ({ status, senderID, msgID }, { lecteurID, isGroup, lastReadMsgID }) => {
  const brut = Number(status) || 0;
  if (!isGroup || Number(senderID) === Number(lecteurID)) return brut;
  if (lastReadMsgID == null) return brut;
  if (Number(msgID) <= Number(lastReadMsgID)) return 3;
  return Math.min(brut, 2);
};

/**
 * Réécrit `status` sur des lignes `message` pour [lecteurID], puis retire les
 * champs techniques `_isGroup` et `_lastReadMsgID` ajoutés par la requête.
 */
const appliquerStatutLecteur = (rows, lecteurID, { isGroup, lastReadMsgID } = {}) => {
  for (const r of rows) {
    const groupe = isGroup ?? Number(r._isGroup) === 1;
    const repere = lastReadMsgID !== undefined ? lastReadMsgID : r._lastReadMsgID;
    r.status = statutPourLecteur(r, { lecteurID, isGroup: groupe, lastReadMsgID: repere });
    delete r._isGroup;
    delete r._lastReadMsgID;
  }
  return rows;
};

const _heure = (v) => (v == null ? null : new Date(v).toISOString());

/**
 * Classe les membres d'un groupe face à un message : lu, reçu (sans l'avoir lu),
 * en attente. L'expéditeur et les membres arrivés après l'envoi n'y figurent pas.
 *
 * @param {object} p
 * @param {{msgID:number, senderID:number, sendAt:Date|string}} p.message
 * @param {Array<{alanyaID:number, nom?:string, pseudo?:string, avatar_url?:string,
 *   joinedAt?:Date|string, historyCutoffAt?:Date|string,
 *   lastDeliveredMsgID?:number|null, lastReadMsgID?:number|null}>} p.membres
 * @param {Map<number, Date|string>} p.heuresLecture  alanyaID → première lecture
 * @param {Map<number, Date|string>} p.heuresReception alanyaID → première réception
 */
const classerAccuses = ({ message, membres, heuresLecture = new Map(), heuresReception = new Map() }) => {
  const msgID = Number(message.msgID);
  const envoi = new Date(message.sendAt).getTime();
  const read = [];
  const delivered = [];
  const pending = [];

  for (const m of membres) {
    const id = Number(m.alanyaID);
    if (id === Number(message.senderID)) continue;
    // Arrivé après l'envoi, ou historique masqué : ce message ne lui a jamais
    // été destiné.
    if (m.joinedAt && new Date(m.joinedAt).getTime() > envoi) continue;
    if (m.historyCutoffAt && new Date(m.historyCutoffAt).getTime() > envoi) continue;

    const fiche = {
      alanyaID: id,
      nom: m.nom ?? null,
      pseudo: m.pseudo ?? null,
      avatar: m.avatar_url ?? null,
    };
    if (m.lastReadMsgID != null && Number(m.lastReadMsgID) >= msgID) {
      read.push({ ...fiche, at: _heure(heuresLecture.get(id)) });
    } else if (m.lastDeliveredMsgID != null && Number(m.lastDeliveredMsgID) >= msgID) {
      delivered.push({ ...fiche, at: _heure(heuresReception.get(id)) });
    } else {
      pending.push({ ...fiche, at: null });
    }
  }

  // Les plus récents d'abord ; heure inconnue (avant la migration) en dernier.
  const parHeure = (a, b) => (b.at ?? '').localeCompare(a.at ?? '');
  read.sort(parHeure);
  delivered.sort(parHeure);
  pending.sort((a, b) => (a.nom ?? a.pseudo ?? '').localeCompare(b.nom ?? b.pseudo ?? '', 'fr'));

  return {
    msgID,
    sentAt: _heure(message.sendAt),
    total: read.length + delivered.length + pending.length,
    readCount: read.length,
    // Comme WhatsApp : « reçu par » compte aussi ceux qui ont lu.
    deliveredCount: read.length + delivered.length,
    read,
    delivered,
    pending,
  };
};

module.exports = {
  KIND_DELIVERED,
  KIND_READ,
  avancerRepereGroupe,
  statutPourLecteur,
  appliquerStatutLecteur,
  classerAccuses,
};
