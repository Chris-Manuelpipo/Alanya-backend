const assert = require('assert');
const {
  buildTripPayload,
  NOTIFICATION_TYPES,
} = require('./notificationContract');

/**
 * Charge utile des notifications de trajet de confiance.
 *
 * Ce fichier existe à cause d'un défaut précis, resté invisible en production :
 * `buildTripPayload` ne produisait **ni `title` ni `body`**. Les envois de
 * trajet sont data-only, donc c'est le client qui compose la notification
 * locale — et il commence par `if (title.isEmpty && body.isEmpty) return;`.
 *
 * L'alerte de sûreté n'affichait donc rien du tout. Elle ne vivait que dans le
 * socket, c'est-à-dire uniquement si l'application du destinataire était déjà
 * ouverte : l'inverse exact de la règle du volet, « une alerte ne transite
 * jamais par la seule room ».
 *
 * Rien dans la suite de tests n'aurait attrapé ça. C'est ce que ce fichier
 * corrige.
 */

const run = () => {
  // ── Le champ dont l'absence rendait l'alerte muette ─────────────────

  const alerte = buildTripPayload({
    type: 'trip_alert',
    tripId: 7,
    state: 'alert',
    ownerId: 3,
    ownerName: 'Awa',
    lastLat: 3.848,
    lastLng: 11.5021,
    title: "Awa n'a pas confirmé son arrivée",
    body: 'Dernière position à 21:44',
  });

  assert.ok(alerte.title && alerte.title.length > 0,
    'sans title, la notification n\'est jamais affichée par le client');
  assert.ok(alerte.body && alerte.body.length > 0,
    'sans body, la notification n\'est jamais affichée par le client');
  assert.strictEqual(alerte.type, 'trip_alert');
  assert.strictEqual(alerte.tripId, '7');
  assert.strictEqual(alerte.ownerId, '3');

  // La deeplink doit désigner le trajet : c'est elle qui ouvre le bon écran.
  assert.strictEqual(alerte.deeplink, 'alanya://trips/7');

  // Tout est sérialisé en chaînes — FCM refuse les autres types dans `data`.
  for (const [cle, valeur] of Object.entries(alerte)) {
    assert.strictEqual(typeof valeur, 'string',
      `${cle} doit être une chaîne pour FCM`);
  }

  // ── L'identifiant d'événement, pour la déduplication ────────────────

  const a = buildTripPayload({ type: 'trip_alert', tripId: 1, state: 'alert' });
  assert.ok(a.eventId.startsWith('trip_alert_1_'),
    'l\'eventId doit porter le type et le trajet');

  const impose = buildTripPayload({
    type: 'trip_sos', tripId: 1, state: 'sos', eventId: 'fixe_42',
  });
  assert.strictEqual(impose.eventId, 'fixe_42');

  // ── Les types déclarés au contrat ───────────────────────────────────

  for (const type of [
    'trip_alert', 'trip_sos', 'trip_closed',
    'trip_eta_soon', 'trip_due', 'trip_reminder',
  ]) {
    assert.ok(NOTIFICATION_TYPES.includes(type),
      `${type} doit être déclaré dans NOTIFICATION_TYPES`);
  }

  // ── Position absente : la charge utile reste valide ─────────────────
  //
  // Une alerte part parfois sans qu'aucune position n'ait jamais été reçue —
  // permission refusée, GPS coupé dès le départ. C'est justement un cas où le
  // cercle doit être prévenu.

  const sansPoint = buildTripPayload({
    type: 'trip_alert',
    tripId: 9,
    state: 'alert',
    ownerId: 2,
    title: 'Alerte',
    body: 'Aucune position reçue',
  });
  assert.strictEqual(sansPoint.tripId, '9');
  assert.ok(sansPoint.title.length > 0);

  // ── Les rappels au propriétaire portent aussi un texte ──────────────

  for (const type of ['trip_eta_soon', 'trip_due', 'trip_reminder']) {
    const rappel = buildTripPayload({
      type,
      tripId: 5,
      state: 'awaiting_confirm',
      ownerId: 4,
      title: 'Confirmez votre arrivée',
      body: 'Sans réponse, vos proches seront prévenus à 21:55.',
    });
    assert.ok(rappel.title.length > 0, `${type} sans titre`);
    assert.ok(rappel.body.length > 0, `${type} sans corps`);
    assert.strictEqual(rappel.deeplink, 'alanya://trips/5');
  }

  console.log('notificationTripPayload : 6 groupes de vérifications passés');
};

run();
