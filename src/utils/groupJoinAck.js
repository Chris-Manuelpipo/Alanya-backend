/**
 * Validation du message système derrière `pendingJoinMsgID`.
 *
 * Extraite du controller pour pouvoir tester sans MySQL : l'ack « Rester »
 * ne doit réussir que si le message est un `member_added` (type 6) où le
 * viewer figure dans `ids`.
 */

const SYSTEM_MSG_TYPE = 6;

/**
 * @param {{ type: unknown, content: unknown, viewerId: number }} args
 * @returns {'ok'|'missing'|'invalid'}
 */
function evaluateJoinAckMessage({ type, content, viewerId }) {
  if (type == null || Number(type) !== SYSTEM_MSG_TYPE) return 'missing';

  let payload = null;
  try {
    payload = typeof content === 'string' ? JSON.parse(content) : null;
  } catch (_) {
    return 'invalid';
  }

  const ids = Array.isArray(payload?.ids)
    ? payload.ids.map((x) => Number(x))
    : [];
  if (payload?.e !== 'member_added' || !ids.includes(Number(viewerId))) {
    return 'invalid';
  }
  return 'ok';
}

module.exports = { evaluateJoinAckMessage, SYSTEM_MSG_TYPE };
