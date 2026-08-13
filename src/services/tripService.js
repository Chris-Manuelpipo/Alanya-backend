/**
 * Trajets de confiance — accès données et carte de conversation.
 *
 * Le contrôleur porte les règles HTTP ; ce module porte le SQL et la mécanique
 * de la carte de type 9. Découpage repris de `broadcastService` / `welcomeService`.
 *
 * Deux idées gouvernent ce fichier :
 *
 *   1. L'audience est FIGÉE au démarrage. `trip_watcher` est un instantané de la
 *      liste Confiance, comme `broadcast_delivery` matérialise l'audience d'une
 *      diffusion. Si l'alerte part, on doit pouvoir dire qui a été prévenu.
 *
 *   2. La carte porte l'ÉTAT, le socket porte le MOUVEMENT. Le message de type 9
 *      est écrit une fois puis réécrit uniquement aux transitions — cinq à six
 *      fois au maximum sur toute la vie d'un trajet. Les positions ne touchent
 *      jamais la table `message`.
 */

const pool = require('../config/db');
const { ensureDirectConversation } = require('./broadcastService');
const { OPEN_STATES, TERMINAL_STATES } = require('../constants/tripPolicy');
const { resolveLastMessagePreview } = require('../utils/mediaAlbum');
const { postSystemMessage } = require('../utils/systemMessage');

const TRIP_MESSAGE_TYPE = 9;

/** Aperçu de la liste des conversations. On délègue à `messagePreview`, seule
 *  définition du libellé par état — une constante locale aurait divergé du jour
 *  où l'on ajoute un état, et `messagePreview` serait resté du code mort. */
const cardPreview = (trip) =>
  resolveLastMessagePreview({ content: cardContent(trip), type: TRIP_MESSAGE_TYPE });

/** Même projection que `MSG_SELECT` (systemMessage.js / messageSend.js). C'est
 *  le format qu'attend `onMessageReceived` côté Flutter : sans les colonnes
 *  jointes, le client rejette la ligne. */
const MSG_SELECT = `
  SELECT m.*, u.nom AS sender_nom, u.pseudo AS sender_pseudo,
         u.avatar_url AS sender_avatar,
         p.timeZone AS messageTz, p.decalageHoraire AS messageTzOffset
  FROM message m
  JOIN users u ON m.senderID = u.alanyaID
  LEFT JOIN pays p ON u.idPays = p.idPays
`;

/** Contenu du message de type 9. Versionné : un client plus ancien doit pouvoir
 *  reconnaître qu'il ne sait pas lire, plutôt qu'afficher du JSON brut. */
const cardContent = (trip) => JSON.stringify({
  v: 1,
  tripId: Number(trip.id),
  kind: trip.kind,
  state: trip.state,
  etaAt: trip.eta_at,
  destLabel: trip.dest_label ?? null,
  note: trip.note ?? null,
  // Le motif de clôture, parce que `closed_cancelled` recouvre deux choses très
  // différentes pour qui reçoit la carte : « j'ai arrêté le partage » et « c'était
  // une fausse alerte, je vais bien ». Sans lui, un cercle qu'on vient d'alarmer
  // lirait « a arrêté le partage » — la pire phrase possible à ce moment-là.
  //
  // Champ ajouté sans changer `v` : un client plus ancien l'ignore et rend
  // exactement ce qu'il rendait avant.
  closeReason: trip.close_reason ?? null,

  // Instantané de position, pour la vignette de la carte.
  //
  // ⚠ Écrit **uniquement aux transitions**, jamais à chaque point. La règle du
  // volet ne change pas d'un iota : la carte porte l'état, le socket porte le
  // mouvement. Réécrire ce message à chaque position remonterait la conversation
  // en tête de liste, rallumerait le compteur de non-lus et déclencherait une
  // notification — toutes les cinq secondes.
  //
  // Une position figée à l'instant d'une transition n'est pas du mouvement :
  // c'est de l'état. C'est elle qui permet à une carte d'alerte de tenir sa
  // promesse — « voir la dernière position » — même une fois la trace purgée,
  // et à un destinataire hors ligne d'ouvrir une vignette qui montre quelque
  // chose plutôt qu'un carré vide.
  //
  // Entre deux transitions, le client anime la vignette depuis le flux temps
  // réel, sans aucune écriture.
  lastLat: trip.last_lat == null ? null : Number(trip.last_lat),
  lastLng: trip.last_lng == null ? null : Number(trip.last_lng),
  lastAt: trip.last_at ?? null,
});

// ---------------------------------------------------------------------------
// Le cercle
// ---------------------------------------------------------------------------

/**
 * Membres de la liste Confiance du propriétaire, blocages exclus DANS LES DEUX
 * SENS. On exclut plutôt que de masquer : le composeur ne doit jamais proposer
 * de confier sa sécurité à quelqu'un qui vous a bloqué.
 */
const loadTrustCircle = async (alanyaID, executor = pool) => {
  const [rows] = await executor.execute(
    `SELECT u.alanyaID, u.nom, u.pseudo, u.avatar_url
       FROM contact_list cl
       JOIN contact_list_member clm ON clm.idList = cl.idList
       JOIN users u                 ON u.alanyaID = clm.idFriend
      WHERE cl.alanyaID = ? AND cl.kind = 'trust'
        AND u.exclus = 0
        AND NOT EXISTS (
              SELECT 1 FROM blocked b
               WHERE (b.alanyaID = ?          AND b.idCallerBlock = u.alanyaID)
                  OR (b.alanyaID = u.alanyaID AND b.idCallerBlock = ?)
            )
      ORDER BY u.nom ASC`,
    [alanyaID, alanyaID, alanyaID],
  );
  return rows;
};

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

const TRIP_SELECT = `
  SELECT t.id, t.owner_id, t.client_id, t.kind, t.state,
         t.dest_lat, t.dest_lng, t.dest_label, t.dest_radius_m,
         t.eta_at, t.grace_minutes, t.max_duration_h, t.extensions, t.note,
         t.owner_device,
         t.last_lat, t.last_lng, t.last_acc_m, t.last_battery,
         t.last_at, t.last_seen_at, t.stale,
         t.started_at, t.prompted_at, t.alerted_at, t.closed_at, t.close_reason
    FROM trip t`;

const num = (v) => (v == null ? null : Number(v));

/** Sérialisation JSON. `viewer` décide de ce qu'on montre : un destinataire ne
 *  voit ni le client_id, ni l'appareil émetteur. */
const tripRow = (r, { watchers = null, isOwner = false } = {}) => ({
  id: Number(r.id),
  ownerId: Number(r.owner_id),
  kind: r.kind,
  state: r.state,
  isOpen: OPEN_STATES.has(r.state),
  destination: r.dest_lat == null ? null : {
    lat: num(r.dest_lat), lng: num(r.dest_lng),
    label: r.dest_label ?? null, radiusM: Number(r.dest_radius_m),
  },
  etaAt: r.eta_at,
  graceMinutes: Number(r.grace_minutes),
  maxDurationH: Number(r.max_duration_h),
  extensions: Number(r.extensions),
  note: r.note ?? null,
  lastPoint: r.last_at == null ? null : {
    lat: num(r.last_lat), lng: num(r.last_lng),
    accuracyM: r.last_acc_m == null ? null : Number(r.last_acc_m),
    batteryPct: r.last_battery == null ? null : Number(r.last_battery),
    recordedAt: r.last_at,
  },
  stale: Boolean(r.stale),
  startedAt: r.started_at,
  promptedAt: r.prompted_at,
  alertedAt: r.alerted_at,
  closedAt: r.closed_at,
  closeReason: r.close_reason ?? null,
  ...(isOwner ? { ownerDevice: r.owner_device ?? null } : {}),
  ...(watchers ? { watchers } : {}),
});

const findTripById = async (id, executor = pool) => {
  const [rows] = await executor.execute(`${TRIP_SELECT} WHERE t.id = ?`, [id]);
  return rows[0] || null;
};

/** Le trajet ouvert du propriétaire, s'il y en a un. */
const findOpenTripByOwner = async (alanyaID, executor = pool) => {
  const [rows] = await executor.execute(
    `${TRIP_SELECT} WHERE t.owner_id = ? AND t.state IN (?, ?, ?, ?) LIMIT 1`,
    [alanyaID, 'active', 'awaiting_confirm', 'alert', 'sos'],
  );
  return rows[0] || null;
};

const findTripByClientId = async (alanyaID, clientId, executor = pool) => {
  const [rows] = await executor.execute(
    `${TRIP_SELECT} WHERE t.owner_id = ? AND t.client_id = ?`, [alanyaID, clientId],
  );
  return rows[0] || null;
};

/** Destinataires d'un trajet. `activeOnly` écarte les révoqués et les partis. */
const loadWatchers = async (tripId, { activeOnly = true } = {}, executor = pool) => {
  const [rows] = await executor.execute(
    `SELECT w.alanyaID, w.state, w.revoke_reason, w.msgID, w.conversID,
            w.added_at, w.notified_at, w.seen_at, w.revoked_at,
            u.nom, u.pseudo, u.avatar_url
       FROM trip_watcher w
       JOIN users u ON u.alanyaID = w.alanyaID
      WHERE w.trip_id = ?${activeOnly ? " AND w.state = 'active'" : ''}
      ORDER BY u.nom ASC`,
    [tripId],
  );
  return rows.map((r) => ({
    alanyaID: Number(r.alanyaID),
    nom: r.nom,
    pseudo: r.pseudo,
    avatarUrl: r.avatar_url,
    state: r.state,
    seenAt: r.seen_at,
    revokedAt: r.revoked_at,
  }));
};

/** Un utilisateur est-il destinataire actif de ce trajet ? Sert d'autorisation
 *  partout : REST, room socket, lecture de la trace. */
const isActiveWatcher = async (tripId, alanyaID, executor = pool) => {
  const [rows] = await executor.execute(
    `SELECT 1 FROM trip_watcher
      WHERE trip_id = ? AND alanyaID = ? AND state = 'active' LIMIT 1`,
    [tripId, alanyaID],
  );
  return rows.length > 0;
};

/** Les trajets ouverts que je suis, en tant que destinataire. */
const findOpenTripsAsWatcher = async (alanyaID, executor = pool) => {
  const [rows] = await executor.execute(
    `${TRIP_SELECT}
       JOIN trip_watcher w ON w.trip_id = t.id
      WHERE w.alanyaID = ? AND w.state = 'active'
        AND t.state IN ('active','awaiting_confirm','alert','sos')
      ORDER BY t.started_at DESC`,
    [alanyaID],
  );
  return rows;
};

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

/** Journal d'audit et source de la frise. `actorId` NULL = système (job). */
const logEvent = async (tripId, kind, { actorId = null, meta = null } = {}, executor = pool) => {
  await executor.execute(
    'INSERT INTO trip_event (trip_id, kind, actor_id, meta) VALUES (?, ?, ?, ?)',
    [tripId, kind, actorId, meta ? JSON.stringify(meta) : null],
  );
};

const loadEvents = async (tripId, executor = pool) => {
  const [rows] = await executor.execute(
    `SELECT kind, actor_id, meta, created_at
       FROM trip_event WHERE trip_id = ? ORDER BY id ASC`,
    [tripId],
  );
  return rows.map((r) => ({
    kind: r.kind,
    actorId: r.actor_id == null ? null : Number(r.actor_id),
    meta: typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta,
    at: r.created_at,
  }));
};

// ---------------------------------------------------------------------------
// La carte de type 9
// ---------------------------------------------------------------------------

/**
 * Pose la carte chez un destinataire. C'est un VRAI message : il compte comme
 * non lu et déclenche une notification — c'est l'annonce « untel a démarré un
 * trajet ». Les mutations suivantes, elles, seront silencieuses.
 */
const postTripCard = async (conn, trip, watcherId) => {
  const conversID = await ensureDirectConversation(conn, trip.owner_id, watcherId);
  const content = cardContent(trip);

  const [result] = await conn.execute(
    `INSERT INTO message
       (senderID, conversationID, clientID, content, type, status, sendAt)
     VALUES (?, ?, NULL, ?, ?, 1, NOW())`,
    [trip.owner_id, conversID, content, TRIP_MESSAGE_TYPE],
  );
  const msgID = result.insertId;

  await conn.execute(
    `UPDATE conversation
        SET lastMessage = ?, lastMessageAt = NOW(),
            lastMessageSenderID = ?, lastMessageType = ?, lastMessageStatus = 1
      WHERE conversID = ?`,
    [cardPreview(trip), trip.owner_id, TRIP_MESSAGE_TYPE, conversID],
  );

  await conn.execute(
    `UPDATE conv_participants SET unreadCount = unreadCount + 1
      WHERE conversID = ? AND alanyaID = ?`,
    [conversID, watcherId],
  );

  // On relit dans la MÊME transaction, mais on n'émet pas ici : `postTripCard`
  // tourne dans la transaction de `createTrip`, et un client qui recevrait le
  // message avant le commit interrogerait une base qui ne le connaît pas encore.
  // C'est l'appelant qui diffuse, après le commit.
  const [rows] = await conn.execute(`${MSG_SELECT} WHERE m.msgID = ?`, [msgID]);

  return { msgID, conversID, watcherId, message: rows[0] || null };
};

/**
 * Diffuse les cartes fraîchement posées. **À appeler après le commit.**
 *
 * Sans cette diffusion, le message existait en base mais n'atteignait le
 * destinataire qu'au prochain sync HTTP — d'où une carte qui « arrive en
 * retard ». Le motif est celui de `postSystemMessage` : on vise les rooms de
 * COMPTE (`user_<id>`) et non `conversation_<id>`, car un destinataire posé sur
 * la liste des discussions n'a pas rejoint la conversation.
 */
const broadcastTripCards = (io, ownerId, cartes) => {
  if (!io) return;
  for (const c of cartes) {
    if (!c?.message) continue;
    io.to([`user_${Number(ownerId)}`, `user_${Number(c.watcherId)}`])
      .emit('message:received', c.message);
  }
};

/**
 * Réécrit la carte après un changement d'état.
 *
 * ⚠ Volontairement, on ne touche NI à `lastMessageAt`, NI à `unreadCount` : un
 * `message:send` remonterait la conversation en tête de liste et relancerait une
 * notification à chaque transition. C'est `trip:card_update` qui informe les
 * clients ouverts, et la notification est décidée séparément, par état.
 *
 * L'aperçu de la conversation est mis à jour uniquement s'il est encore celui de
 * cette carte — sinon on écraserait un message plus récent.
 */
const updateTripCards = async (trip, { io = null } = {}, executor = pool) => {
  const [rows] = await executor.execute(
    `SELECT alanyaID, msgID, conversID FROM trip_watcher
      WHERE trip_id = ? AND state = 'active' AND msgID IS NOT NULL`,
    [trip.id],
  );
  if (!rows.length) return 0;

  const content = cardContent(trip);
  const preview = cardPreview(trip);

  for (const r of rows) {
    await executor.execute('UPDATE message SET content = ? WHERE msgID = ?', [content, r.msgID]);
    await executor.execute(
      `UPDATE conversation
          SET lastMessage = ?
        WHERE conversID = ? AND lastMessageType = ?`,
      [preview, r.conversID, TRIP_MESSAGE_TYPE],
    );
  }

  if (io) {
    // L'owner a aussi la bulle (même msgID) : sans `trip:card_update` vers sa
    // room, son cache Drift reste sur l'état initial (« Suivre en direct »).
    const rooms = [
      ...rows.map((r) => `user_${Number(r.alanyaID)}`),
      `user_${Number(trip.owner_id)}`,
    ];
    io.to([...new Set(rooms)]).emit('trip:card_update', {
      tripId: Number(trip.id),
      state: trip.state,
      content,
    });
  }
  return rows.length;
};

// ---------------------------------------------------------------------------
// La ligne d'incident
// ---------------------------------------------------------------------------

/** État du trajet → événement système écrit dans le fil. */
const INCIDENT_EVENTS = { alert: 'trip_alert', sos: 'trip_sos' };

/**
 * Écrit une **seconde ligne** dans le fil, en plus de la carte, quand le cercle
 * a été prévenu.
 *
 * La carte est réécrite sur place à chaque transition : au bout du compte elle
 * dira « a arrêté le partage » ou « est bien arrivé·e », et l'incident aura
 * disparu du fil. La trace GPS, elle, est purgée au bout de trente jours. Sans
 * cette ligne, il ne resterait donc **rien** de la nuit où l'alerte est partie —
 * ni pour le proche qui veut vérifier ce qu'il a vu, ni pour la personne qui
 * doit prouver ce qui s'est passé.
 *
 * Deux lignes au maximum par trajet : une alerte, puis un SOS. C'est
 * `transition()` qui garantit l'unicité en n'appelant qu'aux vrais changements
 * d'état.
 *
 * Ni non-lu, ni notification poussée : l'alerte a déjà été poussée par
 * `notifyTripAlert`, et faire sonner deux fois le même téléphone pour le même
 * fait n'apprend rien à personne. Cette ligne est une archive, pas une alarme.
 *
 * Un échec n'interrompt jamais l'escalade : l'alerte est déjà partie, elle
 * prime sur sa propre trace.
 */
const postIncidentLine = async (trip, { io = null } = {}) => {
  const event = INCIDENT_EVENTS[trip.state];
  if (!event) return 0;

  try {
    const [rows] = await pool.execute(
      `SELECT alanyaID, conversID FROM trip_watcher
        WHERE trip_id = ? AND state = 'active' AND conversID IS NOT NULL`,
      [trip.id],
    );

    let ecrites = 0;
    for (const r of rows) {
      const msg = await postSystemMessage({
        conversationID: Number(r.conversID),
        actorID: Number(trip.owner_id),
        event,
        payload: { tripId: Number(trip.id) },
        io,
        // Le coupe-circuit des messages de groupe ne doit pas pouvoir effacer
        // une trace d'incident.
        essential: true,
      });
      if (msg) ecrites += 1;
    }
    return ecrites;
  } catch (e) {
    console.error('[Trip] ligne d\'incident échouée:', e.message);
    return 0;
  }
};

module.exports = {
  TRIP_MESSAGE_TYPE,
  broadcastTripCards,
  postIncidentLine,
  cardPreview,
  cardContent,
  loadTrustCircle,
  tripRow,
  findTripById,
  findOpenTripByOwner,
  findTripByClientId,
  findOpenTripsAsWatcher,
  loadWatchers,
  isActiveWatcher,
  logEvent,
  loadEvents,
  postTripCard,
  updateTripCards,
  OPEN_STATES,
  TERMINAL_STATES,
};
