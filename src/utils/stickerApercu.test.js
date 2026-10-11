/**
 * Aperçu et corps de notification d'un sticker — `node src/utils/stickerApercu.test.js`.
 * Contrat §1 : les deux valent « 😀 Sticker », jamais le JSON ni l'image.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { messagePreview, mediaTypeLabel, STICKER_PREVIEW } = require('./messagePreview');
const { resolveLastMessagePreview } = require('./mediaAlbum');

const f = require('../testUtils/stickers/message-sticker-valide.json');
const canonique = f.sortie_serveur;

assert.strictEqual(STICKER_PREVIEW, f.apercu);
assert.strictEqual(STICKER_PREVIEW, f.notification_corps);

// Aperçu de conversation : la ligne telle que le serveur l'écrit
assert.strictEqual(messagePreview({ ...canonique }), f.apercu);
assert.strictEqual(resolveLastMessagePreview({ ...canonique }), f.apercu, 'lastMessage du chemin socket ET HTTP');
// Corps de notification : même appel que services/notificationService, maxLen 100
assert.strictEqual(messagePreview({ ...canonique, isViewOnce: false, isEncrypted: false, maxLen: 100 }), f.notification_corps);

// Jamais le JSON, quel que soit le contenu : version future, cassé, vide, énorme
for (const content of [
  canonique.content,
  '{"v":7,"pack":"x","sid":1,"nouveau":{"a":1}}',
  '{cassé',
  '',
  null,
  undefined,
  `{"v":1,"pad":"${'a'.repeat(5000)}"}`,
]) {
  const p = messagePreview({ type: 10, content, mediaName: 'Sticker 😂' });
  assert.strictEqual(p, '😀 Sticker', `content=${String(content).slice(0, 30)}`);
  assert.ok(!p.includes('{'));
}
// type donné en texte (colonne lue en base, ou client léger)
assert.strictEqual(messagePreview({ type: '10', content: '{"v":1}' }), '😀 Sticker');
assert.strictEqual(mediaTypeLabel(10), '😀 Sticker');

// Le sticker n'est ni une photo ni un album : le marqueur d'album ne l'emporte pas
assert.strictEqual(messagePreview({ type: 10, content: '__talky_album__|x|y|3' }), '😀 Sticker');
// Chiffré reste prioritaire sur tout (le serveur n'a rien à en dire)
assert.strictEqual(messagePreview({ type: 10, content: 'x', isEncrypted: true }), '🔒 Message chiffré');
// Vue unique n'a pas de sens pour un sticker : l'aperçu ne change pas
assert.strictEqual(messagePreview({ type: 10, content: '{"v":1}', isViewOnce: true }), '😀 Sticker');

// Les autres types ne bougent pas (la caractérisation complète est dans
// messagePreview.caracterisation.test.js)
assert.strictEqual(messagePreview({ type: 9, content: '{cassé' }), '🧭 Trajet de confiance');
assert.strictEqual(messagePreview({ type: 0, content: 'salut' }), 'salut');

// Garde de câblage : la notification passe bien par messagePreview, et ne
// court-circuite pas le type 10 vers un corps à elle (ni image, ni JSON).
const notif = fs.readFileSync(path.join(__dirname, '..', 'services', 'notificationService.js'), 'utf8');
assert.ok(/const body = messagePreview\(\{[^}]*type,[^}]*maxLen: 100/s.test(notif), 'le corps de la push vient de messagePreview');
// Les deux chemins d'envoi écrivent lastMessage par resolveLastMessagePreview
for (const rel of ['../socket/handlers/chat/messageSend.js', '../controllers/messageController.js']) {
  const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
  assert.ok(src.includes('resolveLastMessagePreview({'), `${rel} : aperçu par resolveLastMessagePreview`);
}

console.log('stickerApercu.test.js : OK');
