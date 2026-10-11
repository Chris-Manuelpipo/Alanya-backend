/**
 * Citation, transfert par lot et refus Plus d'un sticker —
 * `node src/utils/stickerReponse.test.js`. Tests purs, sans base.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  STICKER_TYPE, sanitizeReplyContent, champsDeTransfert, StickerMessageError, toSocketError,
  resolveStickerFields, FEATURE_PREMIUM,
} = require('./stickerMessage');
const { STICKER_PREVIEW } = require('./messagePreview');
const { emitSendFailed } = require('../socket/handlers/chat/messageSend');

const lire = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const JSON_STICKER = '{"v":1,"pack":"mboa","sid":4812,"emoji":"😂","w":512,"h":512,"a":0}';

// ── 1. Citation d'un sticker : libellé neutre, jamais le JSON ──────────────
assert.strictEqual(STICKER_PREVIEW, '😀 Sticker');
assert.strictEqual(sanitizeReplyContent(JSON_STICKER, STICKER_TYPE), STICKER_PREVIEW, 'type 10 cité');
assert.strictEqual(sanitizeReplyContent('n\'importe quoi', 10), STICKER_PREVIEW, 'type 10 : même un texte libre');
assert.strictEqual(sanitizeReplyContent(JSON_STICKER, null), STICKER_PREVIEW, 'citation non résolue mais JSON sticker');
assert.strictEqual(sanitizeReplyContent('salut', 0), 'salut', 'texte inchangé');
assert.strictEqual(sanitizeReplyContent('{"a":1}', 0), '{"a":1}', 'autre JSON inchangé');
assert.strictEqual(sanitizeReplyContent('{pas du json', null), '{pas du json', 'accolade ordinaire');
assert.strictEqual(sanitizeReplyContent(null, 10), null);
assert.strictEqual(sanitizeReplyContent(undefined, 10), undefined);
assert.strictEqual(sanitizeReplyContent('📍 Douala', 3), '📍 Douala');

// Les deux chemins l'appliquent, avec le type du message cité
const socketSrc = lire('../socket/handlers/chat/messageSend.js');
const httpSrc = lire('../controllers/messageController.js');
for (const [nom, src] of [['socket', socketSrc], ['http', httpSrc]]) {
  assert.ok(/resolveReplyTarget\(conversationID, replyToID\)/.test(src), `${nom} : lit le type du message cité`);
  assert.strictEqual((src.match(/sanitizeReplyContent\(/g) || []).length, 1, `${nom} : un appel à sanitizeReplyContent`);
  assert.ok(!/resolveReplyToID\(/.test(src), `${nom} : plus d'appel sans type`);
}
assert.ok(/sanitizeReplyContent\(replyToContent, replyTarget\.type\)/.test(socketSrc), 'socket : type passé');
assert.ok(/sanitizeReplyContent\(replyToContent \?\? null, replyToType\)/.test(httpSrc), 'http : type passé');

// ── 2. Transfert par lot : par référence, sans légende ─────────────────────
const sticker = { type: 10, content: JSON_STICKER, mediaUrl: 'https://x/ancienne.webp' };
const texte = { type: 0, content: 'bonjour', mediaUrl: null };
const image = { type: 1, content: 'photo', mediaUrl: 'https://x/a.jpg' };
assert.deepStrictEqual(champsDeTransfert(sticker, 0, 'Légende'), { content: JSON_STICKER, copie: false }, 'sticker : pas de légende, pas de copie');
assert.deepStrictEqual(champsDeTransfert(sticker, 1, ''), { content: JSON_STICKER, copie: false });
assert.deepStrictEqual(champsDeTransfert(texte, 0, 'Légende'), { content: 'Légende', copie: true }, 'légende sur le premier non-sticker');
assert.deepStrictEqual(champsDeTransfert(image, 1, 'Légende'), { content: 'photo', copie: true }, 'légende : premier seulement');
assert.deepStrictEqual(champsDeTransfert(image, 0, ''), { content: 'photo', copie: true });
assert.ok(/!copie\s*\?\s*null\s*:\s*await copyForForward/.test(httpSrc), 'lot : aucune copie de fichier pour un sticker');
assert.ok(/!estSticker\(m\.type\) && !m\.mediaUrl/.test(httpSrc), 'lot : un sticker sans URL source reste transférable');
// Le lot passe par _persistAndDeliverMessage → resolveStickerFields : mediaUrl recalculée
const lot = httpSrc.slice(httpSrc.indexOf('const batchForwardMessages'));
assert.ok(/_persistAndDeliverMessage\(/.test(lot) && /type: source\.type/.test(lot), 'lot : type conservé, écriture par _persistMessage');

(async () => {
  // mediaUrl recalculée : celle de la source est ignorée
  const deps = {
    ouvert: async () => true,
    chargeSticker: async () => ({
      sid: 4812, emoji: '😂', pack_code: 'mboa', is_premium: 0, visibility: 0, pack_status: 1,
      asset_status: 0, storage_key: 'official/stickers/mboa/4812_ab12cd34.webp', width: 512, height: 512, animated: 0, installed: 0,
    }),
    droits: async () => null,
    urlDe: (k) => `https://cdn/${k}`,
  };
  const r = await resolveStickerFields({ type: 10, content: JSON_STICKER, senderID: 7, chiffre: null }, deps);
  assert.strictEqual(r.mediaUrl, 'https://cdn/official/stickers/mboa/4812_ab12cd34.webp');
  assert.notStrictEqual(r.mediaUrl, sticker.mediaUrl);

  // Transfert d'un sticker Plus sans droit : refusé, avec feature
  const plus = { ...deps, chargeSticker: async () => ({ ...(await deps.chargeSticker()), is_premium: 1 }), droits: async () => ({ features: { [FEATURE_PREMIUM]: false } }) };
  await assert.rejects(
    resolveStickerFields({ type: 10, content: JSON_STICKER, senderID: 7, chiffre: null }, plus),
    (e) => e instanceof StickerMessageError && e.code === 'SUBSCRIPTION_REQUIRED' && e.feature === 'stickers_premium',
  );

  // ── 3. Socket : message:send_failed porte feature:"stickers_premium" ────
  const emis = [];
  const socket = { emit: (evt, p) => emis.push([evt, p]) };
  try {
    await resolveStickerFields({ type: 10, content: JSON_STICKER, senderID: 7, chiffre: null }, plus);
    assert.fail('refus attendu');
  } catch (e) {
    // Exactement ce que fait le handler : emitSendFailed(socket, { clientId, ...toSocketError(e) })
    emitSendFailed(socket, { clientId: 'c-1', ...toSocketError(e) });
  }
  assert.strictEqual(emis.length, 1);
  assert.strictEqual(emis[0][0], 'message:send_failed');
  assert.deepStrictEqual(emis[0][1], {
    clientId: 'c-1', code: 'SUBSCRIPTION_REQUIRED', message: 'Pack réservé à Alanya Plus', feature: 'stickers_premium',
  });
  // Sans feature : la clé est absente (ancien format inchangé)
  emis.length = 0;
  emitSendFailed(socket, { clientId: 'c-2', code: 'STICKER_NOT_FOUND', message: 'Sticker introuvable' });
  assert.ok(!('feature' in emis[0][1]));
  // Le handler passe bien par ce chemin
  assert.ok(/emitSendFailed\(socket, \{ clientId, \.\.\.refus \}\)/.test(socketSrc), 'handler : étale le refus (feature comprise)');
  assert.ok(/const refus = toSocketError\(e\)/.test(socketSrc));

  console.log('stickerReponse.test.js : OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
