const assert = require('assert');
const {
  resolveTripPush,
  isTripType,
  isTripAlert,
  TRIP_TYPES,
  CANAL_ALERTE,
  CANAL_TRAJET,
} = require('./notificationTripRouting');

/**
 * Acheminement des notifications de trajet.
 *
 * Trois régressions possibles, toutes déjà survenues, toutes invisibles à la
 * lecture du code :
 *
 *  1. un type de trajet absent des types « visibles » → sur iOS, push de fond,
 *     rien d'affiché ; sur Android, priorité normale et 24 h de TTL ;
 *  2. un canal qui n'est pas `alanya_trip_alert` → l'alerte est étouffée par le
 *     mode silencieux, c'est-à-dire la nuit, précisément quand elle compte ;
 *  3. un TTL de 24 h sur une alerte → elle arrive le lendemain, ce qui est pire
 *     qu'une alerte manquée : le destinataire apprend à ne plus les ouvrir.
 */

const run = () => {
  // ── Les alertes, et elles seules, traversent le silence ─────────────

  for (const type of ['trip_alert', 'trip_sos']) {
    const r = resolveTripPush(type);
    assert.ok(r, `${type} doit être reconnu`);
    assert.strictEqual(r.channelId, CANAL_ALERTE,
      `${type} doit passer par le canal qui traverse « Ne pas déranger »`);
    assert.strictEqual(r.bypassSilence, true);
    assert.strictEqual(r.visible, true);
    assert.ok(r.ttlMs <= 120_000,
      `${type} : une alerte périmée décrédibilise les suivantes`);
    assert.strictEqual(r.color, '#EF4444');
    assert.strictEqual(isTripAlert(type), true);
  }

  // ── Les rappels au propriétaire ne réveillent personne ──────────────

  for (const type of ['trip_eta_soon', 'trip_due', 'trip_reminder']) {
    const r = resolveTripPush(type);
    assert.ok(r, `${type} doit être reconnu`);
    assert.strictEqual(r.channelId, CANAL_TRAJET,
      `${type} sur le canal d'alarme ferait couper le canal par l'utilisateur`);
    assert.strictEqual(r.bypassSilence, false,
      `${type} n'est pas une alerte : il ne doit pas forcer le silence`);
    assert.strictEqual(r.visible, true);
    assert.strictEqual(isTripAlert(type), false);
  }

  // ── La clôture rassure, elle n'urge pas ─────────────────────────────

  const clos = resolveTripPush('trip_closed');
  assert.strictEqual(clos.channelId, CANAL_TRAJET);
  assert.strictEqual(clos.bypassSilence, false);
  assert.ok(clos.ttlMs > 120_000, 'une clôture n\'a pas à périmer en 2 min');

  // ── Tous les types déclarés sont résolus ────────────────────────────

  for (const type of TRIP_TYPES) {
    const r = resolveTripPush(type);
    assert.ok(r, `${type} déclaré mais non résolu`);
    assert.ok(Number.isFinite(r.ttlMs) && r.ttlMs > 0,
      `${type} sans TTL exploitable`);
    assert.ok(r.channelId.length > 0);
  }

  // ── Ce qui n'est pas un trajet reste hors de ce module ──────────────

  for (const type of ['message', 'call', 'meeting_invite', '', null, undefined]) {
    assert.strictEqual(resolveTripPush(type), null, `${type} n'est pas un trajet`);
    assert.strictEqual(isTripType(type), false);
  }

  // ── Les identifiants de canal sont un contrat avec le client ────────
  //
  // Ils doivent correspondre mot pour mot à ceux créés dans
  // `local_notification_helper.dart`. Un identifiant inconnu fait retomber
  // Android sur un canal par défaut, sans le moindre signe d'erreur.
  assert.strictEqual(CANAL_ALERTE, 'alanya_trip_alert');
  assert.strictEqual(CANAL_TRAJET, 'alanya_trip');

  console.log(`notificationTripRouting : ${TRIP_TYPES.length} types vérifiés`);
};

run();
