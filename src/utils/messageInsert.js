/**
 * INSERT partagé entre le chemin HTTP (`POST /conversations/:id/messages`,
 * réponse rapide depuis la notification) et le chemin socket (`message:send`).
 *
 * 20 colonnes, dont `status = 1` et `sendAt = NOW()` en littéraux → 18 `?`.
 * Un décalage placeholders / params faisait échouer le POST natif en 500 :
 * la réponse restait en file et ne partait que via le socket à l'ouverture
 * de la discussion.
 */
const MESSAGE_INSERT_SQL = `
INSERT INTO message
  (senderID, conversationID, clientID, content, type, status, sendAt,
   clickSentAt,
   mediaUrl, mediaName, mediaDuration, mediaThumb, mediaSize, mediaPageCount,
   replyToID, replyToContent, isStatusReply, isForwarded, isViewOnce, mentions)
VALUES (?, ?, ?, ?, ?, 1, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE msgID = LAST_INSERT_ID(msgID)
`;

function messageInsertParams({
  senderID,
  conversationID,
  clientId,
  content,
  type,
  clickSentAt,
  mediaUrl,
  mediaName,
  mediaDuration,
  mediaThumb,
  mediaSize,
  mediaPageCount,
  replyToID,
  replyToContent,
  isStatusReply,
  isForwarded,
  isViewOnce,
  mentionsSerialized,
}) {
  return [
    senderID,
    conversationID,
    clientId ?? null,
    content ?? null,
    type,
    clickSentAt ? new Date(clickSentAt) : null,
    mediaUrl ?? null,
    mediaName ?? null,
    mediaDuration ?? null,
    mediaThumb ?? null,
    mediaSize ?? null,
    mediaPageCount ?? null,
    replyToID,
    replyToContent,
    isStatusReply,
    isForwarded ? 1 : 0,
    isViewOnce ? 1 : 0,
    mentionsSerialized,
  ];
}

module.exports = { MESSAGE_INSERT_SQL, messageInsertParams };
