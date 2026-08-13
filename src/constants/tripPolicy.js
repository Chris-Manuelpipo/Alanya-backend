/**
 * Politique des trajets de confiance — cadence GPS, échéances, seuils.
 *
 * Deux familles de valeurs, qui ne se propagent PAS de la même façon :
 *
 *   • CADENCE (régimes, filtres, planchers, battements) — pures dépenses.
 *     Elles sont SERVIES au client dans chaque réponse portant un trajet, et
 *     s'appliquent à chaud, y compris sur un trajet déjà en cours.
 *     ⚠ Elles ne doivent JAMAIS être figées en constantes Dart : la cadence
 *     s'exécute sur le téléphone, et les changer imposerait une publication de
 *     l'application. Le client ne se sert de ses constantes que si le champ
 *     `policy` manque (serveur ancien, réponse tronquée).
 *
 *   • CONTRAT (grâce, relances, durée maximale, rayon) — ce qui a été promis à
 *     l'utilisateur au départ. Recopié dans la ligne `trip` à la création ;
 *     un réglage ultérieur ne modifie jamais un trajet déjà parti. Sinon on
 *     changerait le contrat après signature.
 *
 * Réglage : variables d'environnement, comme NOTIFICATION_ANDROID_NATIVE_V2.
 * Il n'existe pas de table de réglages globale dans Alanya — `appSettingsService`
 * est par utilisateur.
 */

/** Lit un entier d'environnement, borné. Une valeur absurde ne doit pas
 *  pouvoir casser le suivi : on retombe sur le défaut plutôt que sur NaN. */
const readInt = (name, defaultValue, { min, max }) => {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.min(max, Math.max(min, n));
};

// ---------------------------------------------------------------------------
// Cadence — les trois régimes
// ---------------------------------------------------------------------------
// `filterM`  : distanceFilter de getPositionStream. C'est le déclencheur : l'OS
//              pousse un point quand l'appareil a bougé d'autant. À l'arrêt, il
//              n'émet rien.
// `floorS`   : intervalle MINIMUM entre deux envois. Sans lui, le débit est
//              proportionnel à la vitesse — un filtre de 50 m produit un point
//              toutes les 36 s à pied mais toutes les 6 s dans un taxi. Les
//              points intermédiaires ne sont pas jetés : ils sont groupés dans
//              l'envoi suivant.
// `beatS`    : battement. Force un envoi si le flux n'a rien produit depuis ce
//              délai — c'est la SEULE chose qui distingue « immobile » de
//              « traceur mort ». Il ne rallume pas le GPS : il renvoie le
//              dernier point connu avec son horodatage de capture réel.

// ---------------------------------------------------------------------------
// Filtre nominal par type de trajet — taxi vs à pied
// ---------------------------------------------------------------------------
// Un taxi en ville franchit 75 m en quelques secondes : le même filtre que
// pour un piéton saturerait le flux. Inversement, 450 m à pied laisserait
// trop longtemps le cercle sans nouvelle position. Le type choisi à la
// composition fixe donc le distanceFilter du régime *nominal* ; approche et
// alerte restent partagés (plus serrés, indépendants du moyen de transport).
//
// TRIP_FILTER_M_NOMINAL : repli historique si TRIP_FILTER_M_WALK est absent.
const _filtreWalkDefaut = readInt('TRIP_FILTER_M_NOMINAL', 75, { min: 10, max: 500 });
const FILTER_M_BY_KIND = {
  taxi: readInt('TRIP_FILTER_M_TAXI', 450, { min: 50, max: 2000 }),
  walk: readInt('TRIP_FILTER_M_WALK', _filtreWalkDefaut, { min: 10, max: 500 }),
};
// Alias historique (rendez-vous → à pied).
FILTER_M_BY_KIND.meeting = FILTER_M_BY_KIND.walk;

/** Filtre mètres du régime nominal pour un kind. `sos` / inconnu → walk. */
const filterMForKind = (kind) => {
  if (kind === 'taxi') return FILTER_M_BY_KIND.taxi;
  return FILTER_M_BY_KIND.walk;
};

const REGIMES = {
  // ⚠ `balanced` désigne l'équilibre batterie/cadence, PAS une précision
  // dégradée : le client le traduit en `LocationAccuracy.high`. Demander
  // `medium` reviendrait à 100–500 m — une précision de quartier, inutilisable
  // pour retrouver quelqu'un comme pour détecter une arrivée.
  nominal: {
    accuracy: 'balanced',
    // Filtre « générique » pour clients anciens (sans filterMByKind) :
    // cadence piéton. Les clients récents écrasent via filterMByKind[kind]
    // en régime nominal uniquement — approche / alerte restent ci-dessous.
    filterM: FILTER_M_BY_KIND.walk,
    floorS: readInt('TRIP_FLOOR_S_NOMINAL', 5, { min: 1, max: 300 }),
    beatS: readInt('TRIP_BEAT_S_NOMINAL', 45, { min: 15, max: 900 }),
  },
  approach: {
    accuracy: 'high',
    filterM: readInt('TRIP_FILTER_M_APPROACH', 15, { min: 5, max: 300 }),
    floorS: readInt('TRIP_FLOOR_S_APPROACH', 4, { min: 1, max: 120 }),
    beatS: readInt('TRIP_BEAT_S_APPROACH', 20, { min: 10, max: 300 }),
  },
  // ⚠ Le seul régime où la précision sert vraiment. À ne pas relâcher.
  alert: {
    accuracy: 'best',
    filterM: readInt('TRIP_FILTER_M_ALERT', 15, { min: 0, max: 100 }),
    floorS: readInt('TRIP_FLOOR_S_ALERT', 5, { min: 1, max: 60 }),
    beatS: readInt('TRIP_BEAT_S_ALERT', 15, { min: 5, max: 120 }),
  },
};

/** Seuil de péremption : au-delà, le serveur pose `stale` et l'affiche en gris.
 *  Dérivé du battement — sans rythme attendu, aucun moyen de décider à quel
 *  moment un silence devient anormal. Ce N'EST PAS une alerte. */
const STALE_FACTOR = readInt('TRIP_STALE_FACTOR', 3, { min: 2, max: 10 });
const STALE_MARGIN_S = 30;

const staleAfterSeconds = (regimeName) =>
  (REGIMES[regimeName] || REGIMES.nominal).beatS * STALE_FACTOR + STALE_MARGIN_S;

// ---------------------------------------------------------------------------
// Décimation serveur
// ---------------------------------------------------------------------------
// 2 s : au-delà, le pin saute d'un bond au lieu de glisser, et le suivi ne
// ressemble plus à du temps réel. Le coût reste borné — c'est un plafond, pas
// une cadence garantie.
const BROADCAST_MIN_S = readInt('TRIP_BROADCAST_MIN_S', 2, { min: 1, max: 60 });
const PERSIST_MIN_S = readInt('TRIP_PERSIST_MIN_S', 20, { min: 5, max: 300 });

/** Au-delà de cette imprécision, le relevé est ignoré POUR LA DÉTECTION
 *  d'arrivée — mais reste affiché, grisé, avec son cercle de précision. Mieux
 *  vaut dire « à 60 m près » que planter un point mensonger. */
const MAX_ACCURACY_M = readInt('TRIP_MAX_ACCURACY_M', 100, { min: 20, max: 1000 });

// ---------------------------------------------------------------------------
// Contrat — recopié dans `trip` à la création
// ---------------------------------------------------------------------------
// L'escalade tient le cercle à l'écart aussi longtemps que possible : sous
// 5 minutes de grâce, chaque embouteillage devient une alerte et le cercle
// apprend à ne plus les ouvrir. C'est le vrai mode de défaillance du produit.
const CONTRACT = {
  graceMinutes: readInt('TRIP_GRACE_MIN', 10, { min: 2, max: 60 }),
  maxDurationH: readInt('TRIP_MAX_DURATION_H', 12, { min: 1, max: 48 }),
  destRadiusM: readInt('TRIP_DEST_RADIUS_M', 100, { min: 30, max: 2000 }),
  // Hystérésis : il faut RESTER dans le rayon. Passer devant sa rue sans
  // s'arrêter est le faux positif numéro un.
  arrivalHysteresisS: readInt('TRIP_ARRIVAL_HYSTERESIS_S', 60, { min: 10, max: 600 }),
  // Portillon de vitesse : on n'arrive pas à 60 km/h.
  arrivalMaxSpeedKmh: readInt('TRIP_ARRIVAL_MAX_SPEED_KMH', 15, { min: 3, max: 60 }),
  // Relances au propriétaire SEUL, en minutes après l'échéance.
  reminderOffsetsMin: [0, 3, 7],
  // Rappel silencieux avant l'échéance, au propriétaire seul.
  etaSoonMin: readInt('TRIP_ETA_SOON_MIN', 5, { min: 1, max: 30 }),
  // Délai avant clôture automatique quand il ne reste plus aucun destinataire.
  noWatcherGraceMin: readInt('TRIP_NO_WATCHER_MIN', 5, { min: 1, max: 30 }),
};

// ---------------------------------------------------------------------------
// Batterie
// ---------------------------------------------------------------------------
const LOW_BATTERY_PCT = readInt('TRIP_LOW_BATTERY_PCT', 15, { min: 0, max: 50 });
const CRITICAL_BATTERY_PCT = readInt('TRIP_CRITICAL_BATTERY_PCT', 5, { min: 0, max: 30 });

// ---------------------------------------------------------------------------
// Rétention
// ---------------------------------------------------------------------------
const RETENTION = {
  // La trace brute. Un registre permanent des déplacements de tous les
  // utilisateurs n'est justifié par aucun besoin produit.
  pointsHours: readInt('TRIP_POINTS_RETENTION_H', 24, { min: 1, max: 720 }),
  // Plus long si le trajet s'est clos sur un incident : la trace peut être une
  // preuve.
  pointsIncidentDays: readInt('TRIP_POINTS_INCIDENT_D', 30, { min: 1, max: 365 }),
  // Le fait lui-même.
  tripMonths: readInt('TRIP_RETENTION_MONTHS', 12, { min: 1, max: 60 }),
  // Verrou anti-coercition : un trajet clos sur une alerte ne peut pas être
  // supprimé avant ce délai. Personne ne doit pouvoir contraindre un proche à
  // effacer la trace d'un incident dans la minute.
  incidentDeleteLockDays: readInt('TRIP_INCIDENT_LOCK_D', 30, { min: 0, max: 365 }),
};

/** Plafond de SOS par fenêtre glissante de 24 h. Au-delà, on refuse : un bouton
 *  d'alarme qui part sans cesse cesse d'être écouté, et c'est le cercle qui en
 *  paie le prix. */
const SOS_MAX_24H = readInt('TRIP_SOS_MAX_24H', 10, { min: 1, max: 100 });

// ---------------------------------------------------------------------------
// Choix du régime — fonction PURE, c'est elle que testent les tests unitaires
// ---------------------------------------------------------------------------

const OPEN_STATES = new Set(['active', 'awaiting_confirm', 'alert', 'sos']);
const ALERT_STATES = new Set(['alert', 'sos']);
const TERMINAL_STATES = new Set([
  'closed_confirmed', 'closed_cancelled', 'closed_expired', 'closed_unwatched',
]);

const APPROACH_MS = 10 * 60 * 1000;
const APPROACH_M = 1000;

/**
 * @param {object} ctx
 * @param {string} ctx.state          état du trajet
 * @param {string} [ctx.kind]        taxi | walk (défaut taxi ; meeting → walk)
 * @param {number|null} ctx.msToEta   millisecondes avant l'échéance (négatif = dépassée)
 * @param {number|null} ctx.distanceToDestM  distance à la destination, si connue
 * @param {number|null} ctx.batteryPct
 * @returns {{name: string, accuracy: string, filterM: number, floorS: number, beatS: number}}
 */
const regimeFor = ({ state, kind = 'taxi', msToEta = null, distanceToDestM = null, batteryPct = null } = {}) => {
  const avecFiltreKind = (name, base) => {
    // Approche / alerte : filtres serrés inchangés. Nominal : taxi vs à pied.
    if (name !== 'nominal') return { name, ...base };
    return { name, ...base, filterM: filterMForKind(kind) };
  };

  // L'alerte l'emporte sur tout, batterie comprise : c'est le moment où la
  // position sert vraiment.
  if (ALERT_STATES.has(state)) return avecFiltreKind('alert', REGIMES.alert);

  // Garde batterie : on ralentit, et le cercle en est informé.
  if (batteryPct !== null && batteryPct <= LOW_BATTERY_PCT) {
    return avecFiltreKind('nominal', {
      ...REGIMES.nominal,
      floorS: Math.max(REGIMES.nominal.floorS, 60),
      beatS: Math.max(REGIMES.nominal.beatS, 120),
    });
  }

  const procheDansLeTemps = msToEta !== null && msToEta <= APPROACH_MS;
  const procheDansLEspace = distanceToDestM !== null && distanceToDestM <= APPROACH_M;
  if (procheDansLeTemps || procheDansLEspace) {
    return avecFiltreKind('approach', REGIMES.approach);
  }

  return avecFiltreKind('nominal', REGIMES.nominal);
};

/** Ce qui part vers le client dans chaque réponse portant un trajet.
 *  Doit exister DÈS la première version, même sans surprise : l'ajouter plus
 *  tard imposerait la publication d'application qu'on cherche à éviter. */
const publicPolicy = () => ({
  version: 1,
  regimes: REGIMES,
  // DistanceFilter du régime nominal selon le type choisi à la composition.
  // Le client l'applique localement ; sans ce champ (serveur ancien), il
  // retombe sur ses défauts taxi=450 / walk=75.
  filterMByKind: {
    taxi: FILTER_M_BY_KIND.taxi,
    walk: FILTER_M_BY_KIND.walk,
  },
  // Valeurs de contrat exposées en LECTURE : l'écran de composition doit
  // pouvoir écrire « si vous n'avez pas confirmé à 21:55, vos proches seront
  // prévenus » AVANT que le trajet n'existe. Sans elles, il devrait supposer la
  // grâce — et la phrase deviendrait fausse dès qu'on règle TRIP_GRACE_MIN.
  // Le client ne les envoie jamais : c'est le serveur qui les fige à la
  // création, dans la ligne `trip`.
  contract: {
    graceMinutes: CONTRACT.graceMinutes,
    maxDurationH: CONTRACT.maxDurationH,
    etaSoonMin: CONTRACT.etaSoonMin,
  },
  staleFactor: STALE_FACTOR,
  staleMarginS: STALE_MARGIN_S,
  maxAccuracyM: MAX_ACCURACY_M,
  lowBatteryPct: LOW_BATTERY_PCT,
  criticalBatteryPct: CRITICAL_BATTERY_PCT,
  approachMs: APPROACH_MS,
  approachM: APPROACH_M,
});

module.exports = {
  REGIMES,
  FILTER_M_BY_KIND,
  CONTRACT,
  RETENTION,
  SOS_MAX_24H,
  STALE_FACTOR,
  STALE_MARGIN_S,
  BROADCAST_MIN_S,
  PERSIST_MIN_S,
  MAX_ACCURACY_M,
  LOW_BATTERY_PCT,
  CRITICAL_BATTERY_PCT,
  OPEN_STATES,
  ALERT_STATES,
  TERMINAL_STATES,
  staleAfterSeconds,
  filterMForKind,
  regimeFor,
  publicPolicy,
};
