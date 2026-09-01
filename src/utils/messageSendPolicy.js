const pool = require('../config/db');
const { ACCOUNT_TYPE } = require('../constants/accountTypes');
const { isSelfChatRow } = require('./directConversation');

/**
 * Autorisation d'envoi, en 1 ou 2 allers-retours SQL.
 *
 * Chemin rapide dédié à `message:send`. Il rend exactement les mêmes verdicts
 * que l'enchaînement `assertCanSendToConversation` → `evaluateDirectMessageSend`
 * (lui-même trois requêtes : pair, type de compte, blocages), mais en fusionnant
 * ce qui porte sur les mêmes lignes :
 *
 *   1. appartenance + mode annonce + résolution du pair   → 1 requête
 *   2. type de compte du pair + blocages bidirectionnels  → 1 requête (1-1 seul)
 *
 * Soit 4 allers-retours ramenés à 2 — et à 1 pour un groupe. Sur une base qui
 * n'est pas colocalisée avec le backend, chacun se paye au prix fort et retarde
 * d'autant l'accusé qui fait passer la bulle de l'horloge au ✓.
 *
 * Les fonctions d'origine restent en place : elles ont d'autres appelants
 * (accusés de réception, présence) dont les besoins diffèrent.
 *
 * @returns {Promise<{ok: false, code: string, message: string}
 *                 | {ok: true, isDirect: boolean, peerId: number|null, silentDrop: boolean}>}
 */
async function resolveSendPolicy(conversationID, senderID) {
  const [rows] = await pool.execute(
    `SELECT c.isGroup, c.GroupName, c.onlyAdminsCanSend, cp.role,
            (SELECT COUNT(*) FROM conv_participants p
              WHERE p.conversID = c.conversID AND p.alanyaID != ?) AS peerCount,
            (SELECT p.alanyaID FROM conv_participants p
              WHERE p.conversID = c.conversID AND p.alanyaID != ?
              LIMIT 1) AS peerId
       FROM conversation c
       LEFT JOIN conv_participants cp
              ON cp.conversID = c.conversID AND cp.alanyaID = ?
      WHERE c.conversID = ?
      LIMIT 1`,
    [senderID, senderID, senderID, conversationID],
  );

  const conv = rows[0];
  if (!conv) {
    return {
      ok: false,
      code: 'CONVERSATION_NOT_FOUND',
      message: 'Conversation introuvable',
    };
  }

  // LEFT JOIN : la conversation existe mais je n'en suis pas membre.
  if (conv.role == null) {
    return {
      ok: false,
      code: 'NOT_A_MEMBER',
      message: 'Vous ne faites pas partie de cette conversation',
    };
  }

  if (conv.isGroup && conv.onlyAdminsCanSend && Number(conv.role) < 1) {
    return {
      ok: false,
      code: 'GROUP_ADMINS_ONLY',
      message: 'Seuls les administrateurs peuvent envoyer des messages',
    };
  }

  // Même définition du « 1-1 » que `getDirectConversationPeer` : ni groupe, ni
  // conversation avec soi-même (qui n'a pas de pair et échappe donc à toute la
  // politique de blocage), et exactement un autre participant.
  const isDirect =
    !conv.isGroup && !isSelfChatRow(conv) && Number(conv.peerCount) === 1;
  if (!isDirect || conv.peerId == null) {
    return { ok: true, isDirect: false, peerId: null, silentDrop: false };
  }

  const peerId = Number(conv.peerId);
  const [peerRows] = await pool.execute(
    `SELECT u.account_type,
            EXISTS(SELECT 1 FROM blocked b
                    WHERE b.alanyaID = ? AND b.idCallerBlock = ?) AS iBlockedThem,
            EXISTS(SELECT 1 FROM blocked b
                    WHERE b.alanyaID = ? AND b.idCallerBlock = ?) AS theyBlockedMe
       FROM users u
      WHERE u.alanyaID = ?
      LIMIT 1`,
    [senderID, peerId, peerId, senderID, peerId],
  );

  const peer = peerRows[0];
  // Pair introuvable : on laisse passer plutôt que de bloquer un envoi sur une
  // donnée manquante — même issue qu'avant, où le SELECT vide ne rejetait pas.
  if (!peer) {
    return { ok: true, isDirect: true, peerId, silentDrop: false };
  }

  if (Number(peer.account_type) === ACCOUNT_TYPE.OFFICIEL) {
    return {
      ok: false,
      code: 'OFFICIAL_READONLY',
      message: 'Cannot message blocked user',
    };
  }

  if (Number(peer.iBlockedThem) === 1) {
    return {
      ok: false,
      code: 'BLOCKED_BY_SENDER',
      message: 'Cannot message blocked user',
    };
  }

  // Bloqué par le destinataire : le message est accepté et persisté, mais
  // n'est ni diffusé ni compté comme non-lu chez lui.
  return {
    ok: true,
    isDirect: true,
    peerId,
    silentDrop: Number(peer.theyBlockedMe) === 1,
  };
}

module.exports = { resolveSendPolicy };
