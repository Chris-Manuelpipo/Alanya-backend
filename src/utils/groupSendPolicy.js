const pool = require('../config/db');

/**
 * Autorisation d'envoi dans une conversation.
 *
 * Comble un trou réel : avant cette fonction, seul `evaluateDirectMessageSend`
 * tournait sur le chemin d'envoi, et il ne traite QUE le 1-1 (il renvoie
 * `{ isDirect: false }` et sort dès que la conversation est un groupe). Rien ne
 * vérifiait donc qu'un expéditeur était bien membre du groupe où il écrit.
 *
 * Une seule requête : appartenance, rôle et mode annonce arrivent ensemble.
 *
 * @returns {Promise<{ok: true} | {ok: false, code: string, message: string}>}
 */
const assertCanSendToConversation = async (conversationID, senderID) => {
  const [rows] = await pool.execute(
    `SELECT c.isGroup, c.onlyAdminsCanSend, cp.role
       FROM conversation c
       LEFT JOIN conv_participants cp
              ON cp.conversID = c.conversID AND cp.alanyaID = ?
      WHERE c.conversID = ?`,
    [senderID, conversationID],
  );

  if (rows.length === 0) {
    return {
      ok: false,
      code: 'CONVERSATION_NOT_FOUND',
      message: 'Conversation introuvable',
    };
  }

  // LEFT JOIN : la conversation existe mais je n'y suis pas.
  if (rows[0].role == null) {
    return {
      ok: false,
      code: 'NOT_A_MEMBER',
      message: 'Vous ne faites pas partie de cette conversation',
    };
  }

  if (rows[0].isGroup && rows[0].onlyAdminsCanSend && Number(rows[0].role) < 1) {
    return {
      ok: false,
      code: 'GROUP_ADMINS_ONLY',
      message: 'Seuls les administrateurs peuvent envoyer des messages',
    };
  }

  return { ok: true };
};

module.exports = { assertCanSendToConversation };
