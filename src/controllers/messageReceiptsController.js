const pool = require('../config/db');
const { fail, failInternal } = require('../utils/apiError');
const { classerAccuses, KIND_DELIVERED, KIND_READ } = require('../utils/groupReceipts');

/**
 * GET /api/messages/:id/receipts — qui a lu, qui a reçu, qui n'a encore rien reçu
 * d'un de MES messages de groupe (écran « Infos du message », migration 096).
 *
 * Réservé à l'expéditeur, comme sur WhatsApp. Un message inconnu, qui n'est pas
 * le mien, ou que j'ai supprimé répond 404 sans distinguer les cas : on ne
 * confirme pas l'existence d'un message à quelqu'un qui ne l'a pas envoyé.
 */
const getMessageReceipts = async (req, res) => {
  try {
    return await _receipts(req, res);
  } catch (e) {
    // Express 4 ne rattrape pas les rejets : sans ceci, la requête resterait
    // pendante. Le détail part au journal, jamais au client.
    console.error('[getMessageReceipts]', e.code || '', e.message);
    return failInternal(res, 'Accusés indisponibles');
  }
};

const _receipts = async (req, res) => {
  const alanyaID = req.user.alanyaID;
  const msgID = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(msgID) || msgID <= 0) {
    return fail(res, 404, 'MESSAGE_NOT_FOUND', 'Message introuvable');
  }

  const [[message]] = await pool.execute(
    `SELECT m.msgID, m.senderID, m.sendAt, m.conversationID, c.isGroup
     FROM message m
     JOIN conversation c ON c.conversID = m.conversationID
     WHERE m.msgID = ? AND m.isDeleted = 0`,
    [msgID],
  );
  if (!message || Number(message.senderID) !== Number(alanyaID)) {
    return fail(res, 404, 'MESSAGE_NOT_FOUND', 'Message introuvable');
  }
  if (Number(message.isGroup) !== 1) {
    return fail(res, 400, 'NOT_GROUP_MESSAGE', 'Réservé aux messages de groupe');
  }

  const convID = message.conversationID;
  const [membres] = await pool.execute(
    `SELECT cp.alanyaID, cp.joinedAt, cp.historyCutoffAt,
            cp.lastDeliveredMsgID, cp.lastReadMsgID,
            u.nom, u.pseudo, u.avatar_url
     FROM conv_participants cp
     JOIN users u ON u.alanyaID = cp.alanyaID
     WHERE cp.conversID = ? AND cp.alanyaID != ?`,
    [convID, alanyaID],
  );

  // Première avancée de chaque repère au-delà de ce message = heure à laquelle
  // le membre l'a reçu, ou lu.
  const [journal] = await pool.execute(
    `SELECT alanyaID, kind, MIN(at) AS at
     FROM conv_receipt_log
     WHERE conversID = ? AND upToMsgID >= ? AND kind IN (?, ?)
     GROUP BY alanyaID, kind`,
    [convID, msgID, KIND_DELIVERED, KIND_READ],
  );
  const heuresLecture = new Map();
  const heuresReception = new Map();
  for (const l of journal) {
    const cible = Number(l.kind) === KIND_READ ? heuresLecture : heuresReception;
    cible.set(Number(l.alanyaID), l.at);
  }

  return res.json(classerAccuses({ message, membres, heuresLecture, heuresReception }));
};

module.exports = { getMessageReceipts };
