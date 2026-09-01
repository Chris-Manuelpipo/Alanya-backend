/**
 * INSERT partagé entre le chemin HTTP (`POST /conversations/:id/messages`,
 * réponse rapide depuis la notification) et le chemin socket (`message:send`).
 *
 * 19 colonnes, dont `status = 1` en littéral → 18 `?`.
 * Un décalage placeholders / params faisait échouer le POST natif en 500 :
 * la réponse restait en file et ne partait que via le socket à l'ouverture
 * de la discussion.
 *
 * `sendAt` est un paramètre et non `NOW()` : l'appelant connaît ainsi la
 * valeur exacte de la ligne sans avoir à la relire, ce qui supprime un
 * aller-retour SQL du chemin critique de l'accusé d'envoi. Le pool force
 * `SET time_zone = '+00:00'` et mysql2 tourne en `timezone: 'Z'` (voir
 * config/db.js), donc un `Date` JS s'écrit exactement comme `NOW()` écrivait.
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
VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE msgID = LAST_INSERT_ID(msgID)
`;

function messageInsertParams({
  senderID,
  conversationID,
  clientId,
  content,
  type,
  sendAt,
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
    // Jamais null : une ligne sans date d'envoi casserait le tri des bulles.
    sendAt ? new Date(sendAt) : new Date(),
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
