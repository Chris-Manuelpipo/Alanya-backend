/**
 * Résolution des conversations 1-1, y compris la conversation « avec soi-même ».
 *
 * Cette logique était dupliquée à l'identique dans conversationController.js et
 * socket/handlers/calls.js, avec dans les deux cas une double jointure sur
 * conv_participants (cp1/cp2). Cette jointure est **fausse dès que les deux
 * identifiants sont égaux** : `uq_conv_user (conversID, alanyaID)` garantit une
 * seule ligne par (conv, user), donc cp1 et cp2 se lient à la MÊME ligne et la
 * clause dégénère en « n'importe quelle conversation 1-1 où je suis ». Le
 * serveur renvoyait alors la discussion la plus active avec un TIERS.
 */

/**
 * Marqueur d'une conversation « avec soi-même ».
 *
 * Porté par `conversation.GroupName`, colonne inutilisée pour `isGroup = 0`
 * (elle n'est écrite qu'à la création et au renommage d'un groupe). Évite une
 * migration, et surtout évite de déduire le self-chat de « 1-1 avec un seul
 * participant » : `deleteConversation` ne retire que la ligne de l'appelant, si
 * bien qu'une conv 1-1 dont le pair a supprimé son côté — ou dont le compte a
 * été supprimé (fk_cp_user ON DELETE CASCADE) — présente exactement la même
 * forme sans en être une.
 */
const SELF_CHAT_MARKER = '__self__';

/**
 * Construit la requête de recherche d'une conversation 1-1 existante.
 *
 * @returns {{sql: string, params: Array, isSelf: boolean}}
 */
function buildDirectConversationLookup({ meId, peerId }) {
  const me = Number(meId);
  const peer = Number(peerId);
  const isSelf = me === peer;

  if (isSelf) {
    return {
      isSelf: true,
      // La plus ancienne fait foi : une seule conv « moi » par utilisateur, et
      // le choix reste stable si un doublon est apparu.
      sql: `SELECT c.* FROM conversation c
            JOIN conv_participants cp ON c.conversID = cp.conversID
            WHERE cp.alanyaID = ? AND c.isGroup = 0 AND c.GroupName = ?
            ORDER BY c.conversID ASC
            LIMIT 1`,
      params: [me, SELF_CHAT_MARKER],
    };
  }

  return {
    isSelf: false,
    // `cp1.id <> cp2.id` : ceinture — même atteinte avec meId === peerId, la
    // jointure ne peut plus se replier sur une seule ligne.
    // Exclusion du marqueur : bretelles — un self-chat ne doit jamais ressortir
    // comme conversation 1-1 avec un tiers.
    sql: `SELECT c.* FROM conversation c
          JOIN conv_participants cp1 ON c.conversID = cp1.conversID
          JOIN conv_participants cp2 ON c.conversID = cp2.conversID
          WHERE cp1.alanyaID = ? AND cp2.alanyaID = ?
            AND cp1.id <> cp2.id
            AND c.isGroup = 0
            AND (c.GroupName IS NULL OR c.GroupName <> ?)
          ORDER BY (SELECT COUNT(*) FROM message m
                    WHERE m.conversationID = c.conversID AND m.isDeleted = 0) DESC,
                   c.lastMessageAt DESC, c.conversID DESC
          LIMIT 1`,
    params: [me, peer, SELF_CHAT_MARKER],
  };
}

/** Vrai si la ligne conversation est une conversation « avec soi-même ». */
function isSelfChatRow(row) {
  return !row.isGroup && row.GroupName === SELF_CHAT_MARKER;
}

/** Score pour choisir la conv 1-1 canonique entre deux utilisateurs. */
function scoreDirectConversation(row) {
  const msgCount = Number(row.messageCount) || 0;
  const lastAt = row.lastMessageAt ? new Date(row.lastMessageAt).getTime() : 0;
  // Priorité aux conv qui ont de vrais messages (évite les doublons « appel seul »).
  return msgCount * 1e15 + lastAt;
}

/**
 * Une seule entrée 1-1 par paire d'utilisateurs : garde la conversation qui
 * contient le plus de messages, puis la plus récente. Corrige les doublons
 * legacy (aperçu d'appel sur conv B, historique texte sur conv A).
 */
function dedupeDirectConversations(rows, viewerId) {
  const groups = [];
  const byPeer = new Map();
  for (const row of rows) {
    if (row.isGroup) {
      groups.push(row);
      continue;
    }
    // Conversation avec soi-même : une seule par utilisateur, même arbitrage
    // que les 1-1. Sans cette branche elle tomberait dans `groups` par accident
    // (aucun pair trouvé) et échapperait à la déduplication.
    if (isSelfChatRow(row)) {
      const key = `self:${Number(viewerId)}`;
      const existing = byPeer.get(key);
      if (!existing || scoreDirectConversation(row) > scoreDirectConversation(existing)) {
        byPeer.set(key, row);
      }
      continue;
    }
    const peer = row.participants?.find(
      (p) => Number(p.alanyaID) !== Number(viewerId),
    );
    // Conversation orpheline (le pair a supprimé son côté) : conservée telle
    // quelle, jamais fusionnée avec le self-chat.
    if (!peer) {
      groups.push(row);
      continue;
    }
    const a = Math.min(Number(viewerId), Number(peer.alanyaID));
    const b = Math.max(Number(viewerId), Number(peer.alanyaID));
    const key = `${a}:${b}`;
    const existing = byPeer.get(key);
    if (!existing || scoreDirectConversation(row) > scoreDirectConversation(existing)) {
      byPeer.set(key, row);
    }
  }
  const direct = [...byPeer.values()];
  return [...groups, ...direct].sort((x, y) => {
    const pinDiff = (y.isPinned ? 1 : 0) - (x.isPinned ? 1 : 0);
    if (pinDiff !== 0) return pinDiff;
    const xAt = x.lastMessageAt ? new Date(x.lastMessageAt).getTime() : 0;
    const yAt = y.lastMessageAt ? new Date(y.lastMessageAt).getTime() : 0;
    return yAt - xAt;
  });
}

module.exports = {
  SELF_CHAT_MARKER,
  buildDirectConversationLookup,
  isSelfChatRow,
  scoreDirectConversation,
  dedupeDirectConversations,
};
