const assert = require('assert');
const { evaluateMessagePush } = require('./notificationFilter');

// Tout est préchargé : le filtre ne touche pas la base, le test reste pur.
const basePrefs = {
  messagesEnabled: 1,
  groupMessagesEnabled: 1,
  soundEnabled: 1,
  previewMode: 'full',
};

const payload = () => ({
  type: 'message',
  conversationId: '7',
  senderId: '3',
  senderName: 'Alice',
  title: 'Alice',
  body: 'Bonjour',
  senderAvatar: 'https://www.alanya237.com/uploads/images/a.jpg',
  groupAvatar: 'https://www.alanya237.com/uploads/images/g.jpg',
});

// `dnd` doit être un objet, pas null : `preloaded.dnd ?? load…` considère null
// comme « non préchargé » et repartirait interroger la base.
const evaluate = ({ prefs = {}, mute = {}, ...options } = {}) =>
  evaluateMessagePush(1, 7, payload(), {
    ...options,
    preloaded: { prefs: { ...basePrefs, ...prefs }, dnd: { enabled: 0 }, mute },
  });

const run = async () => {
  // Cas nominal : les deux avatars passent.
  const nominal = await evaluate();
  assert.strictEqual(nominal.allowed, true);
  assert.ok(nominal.payload.senderAvatar, 'avatar transmis par défaut');
  assert.ok(nominal.payload.groupAvatar, 'photo de groupe transmise par défaut');

  // Sourdine : push silencieuse pour l'accusé de remise, mais rien de personnel
  // ne voyage — ni le contenu, ni les photos.
  const muted = await evaluate({ mute: { muteForever: 1 } });
  assert.strictEqual(muted.silent, true);
  assert.ok(!('senderAvatar' in muted.payload), 'avatar retiré en sourdine');
  assert.ok(!('groupAvatar' in muted.payload), 'photo de groupe retirée en sourdine');
  assert.ok(!('body' in muted.payload), 'corps toujours retiré en sourdine');

  // Notifications coupées : même règle.
  const off = await evaluate({ prefs: { messagesEnabled: 0 } });
  assert.strictEqual(off.silent, true);
  assert.ok(!('senderAvatar' in off.payload));

  // Aperçu générique : le nom lui-même est masqué, la photo le serait aussi.
  const generic = await evaluate({ prefs: { previewMode: 'generic' } });
  assert.strictEqual(generic.allowed, true);
  assert.ok(!('senderAvatar' in generic.payload), 'avatar retiré en aperçu générique');
  assert.ok(!('groupAvatar' in generic.payload));

  // Valeur inattendue en base : `applyPreviewPolicy` la traite comme générique,
  // le filtre des avatars doit suivre le même chemin.
  const unknownMode = await evaluate({ prefs: { previewMode: 'chose_inconnue' } });
  assert.ok(!('senderAvatar' in unknownMode.payload), 'mode inconnu = générique');

  // `name_only` affiche le nom : garder la photo est cohérent.
  const nameOnly = await evaluate({ prefs: { previewMode: 'name_only' } });
  assert.ok(nameOnly.payload.senderAvatar, 'avatar conservé en name_only');

  // profilePhotoVisibility résolu par le fan-out : le destinataire n'y a pas droit.
  const hidden = await evaluate({ avatarAllowed: false });
  assert.strictEqual(hidden.allowed, true, 'la notification part quand même');
  assert.strictEqual(hidden.payload.body, 'Bonjour', 'seule la photo est retirée');
  assert.ok(!('senderAvatar' in hidden.payload), 'photo réservée aux contacts');
  assert.ok(!('groupAvatar' in hidden.payload));

  console.log('notificationAvatarPolicy.test.js: OK');
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
