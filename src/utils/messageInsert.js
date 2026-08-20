/**
 * INSERT partagé entre le chemin HTTP (`POST /conversations/:id/messages`,
 * réponse rapide depuis la notification) et le chemin socket (`message:send`).
 *
 * 19 colonnes, dont `status = 1` et `sendAt = NOW()` en littéraux → 17 `?`.
 * Un décalage placeholders / params faisait échouer le POST natif en 500 :
 * la réponse restait en file et ne partait que via le socket à l'ouverture
 * de la discussion.
 *
 * `mediaThumb` n'est PAS ici : elle est écrite séparément dans
 * `message_thumb` par `insertMessageThumb`, une fois le `msgID` connu (audit
 * scalabilité 06/08/2026 §2.2 — sortir la vignette base64 de la table la
 * plus chaude du schéma). Voir migration 060.
 */
const MESSAGE_INSERT_SQL = `
INSERT INTO message
  (senderID, conversationID, clientID, content, type, status, sendAt,
   clickSentAt,
   mediaUrl, mediaName, mediaDuration, mediaSize, mediaPageCount,
   replyToID, replyToContent, isStatusReply, isForwarded, isViewOnce, mentions)
VALUES (?, ?, ?, ?, ?, 1, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

/**
 * Écrit (ou remplace) la vignette base64 d'un message dans message_thumb,
 * une fois son msgID connu. No-op silencieux si `mediaThumb` est vide —
 * appelable inconditionnellement après chaque insertion de message.
 */
async function insertMessageThumb(conn, msgID, mediaThumb) {
  if (!mediaThumb) return;
  await conn.execute(
    `INSERT INTO message_thumb (msgID, thumb) VALUES (?, FROM_BASE64(?))
     ON DUPLICATE KEY UPDATE thumb = VALUES(thumb)`,
    [msgID, mediaThumb],
  );
}

module.exports = { MESSAGE_INSERT_SQL, messageInsertParams, insertMessageThumb };
