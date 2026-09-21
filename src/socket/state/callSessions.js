// Registre des sessions d'appel à trois (« Ajouter à l'appel » / transfert).
//
// Un appel 1-à-1 ordinaire n'a PAS de session : il vit entièrement dans callState.
// Une session naît au premier `call_add_participant`. Elle meurt quand il ne reste
// plus assez de monde, ou quand sa toute première invitation échoue (retour à
// l'appel 1-à-1 vierge).
//
// Le droit d'ajout est rendu dès qu'on retombe à deux (docs/transfert_appel.md
// § 4.5) : c'est ce qui permet le transfert en cascade.
//
//   pas de session             → droit DISPONIBLE
//   addRight=available (à deux) → droit DISPONIBLE — greffe par `addPending`
//   addRight=locked            → droit VERROUILLÉ  (un invité sonne)
//   addRight=consumed          → droit ÉPUISÉ      (trois présents)
//
// Dès que quelqu'un est entré (`joins > 0`), la session porte l'appel jusqu'au
// bout : le relais média, la propriété d'appareil et l'historique y sont rangés.
// Un échec d'invitation retire alors l'invité sans détruire la session.
//
// Chaque invitation a son identifiant (`pending.inviteId`) : le sessionId à la
// première, `${sessionId}_r${n}` ensuite. Le téléphone de l'invité marque les
// identifiants terminés pendant deux minutes : réinviter quelqu'un qui a déjà
// été dans la session sous le même identifiant tomberait sur sa marque.
//
// mode vit AU NIVEAU SESSION et change à chaque invitation :
//   mode=join     → transfer === null
//   mode=transfer → objet transfer obligatoire
//
// ── Répartition (Redis si REDIS_URL, sinon repli mémoire) ──
//
// La machine à états ci-dessous est dense et son intérêt tient à sa lisibilité.
// Elle reste donc écrite une seule fois, en JavaScript, et n'est PAS réécrite en
// Lua. Trois mécanismes distincts assurent l'atomicité, chacun choisi pour ce
// qu'il protège :
//
//   1. `openWithPending` — script Lua. C'est la seule opération multi-clés :
//      elle vérifie que TROIS utilisateurs sont libres puis écrit quatre clés.
//      Un contrôle en plusieurs allers-retours laisserait deux ajouts
//      simultanés créer chacun leur session, et le droit d'ajout ne serait
//      plus unique. Le contenu de la session n'est pas interprété par le
//      script : il le reçoit tout fait, en chaîne opaque.
//
//   2. `registerTransferReady` — `HSETNX`. La garde est « armer une seule
//      fois » : poser un champ seulement s'il est absent est exactement cette
//      sémantique, nativement atomique, sans script.
//
//   3. Les autres mutations — verrou court par session. Deux participants qui
//      raccrochent en même temps liraient sinon la même session et la
//      réécriraient chacun, la seconde écriture effaçant la première. Le
//      verrou expire tout seul (2 s) : un process qui meurt en le tenant ne
//      bloque personne durablement.
//
//   4. `addPending` — le verrou de session, plus un `SET NX` sur la clé
//      `byUser` de l'invité. C'est la seule clé partagée avec les autres
//      sessions, et une écriture conditionnelle sur une clé unique est
//      atomique : deux sessions qui invitent la même personne n'en retiennent
//      qu'une.
//
// Les handles `setTimeout` ne se sérialisent pas : côté Redis, les trois
// minuteurs deviennent des lignes `job_queue` (voir services/callSessionsWorkers.js)
// et les champs `timer`/`readyTimer`/`leaveTimer` ne portent plus qu'un booléen.
// `!!session.transfer.leaveTimer` reste donc vrai des deux côtés.

const { getDataClient } = require('../../config/redisData');
const { runScript } = require('../../utils/redisScript');
const { enqueue, cancelByDedupeKey } = require('../../services/jobQueue');

const MAX_SESSION_PARTICIPANTS = 3;

const TRANSFER_READY_TIMEOUT_MS = 25 * 1000;
const TRANSFER_AUTO_LEAVE_MS = 10 * 1000;

const KINDS = ['callsession_no_answer', 'callsession_ready_timeout', 'callsession_auto_leave'];
const dedupeOf = (sessionId) => `call_session_${sessionId}`;

const keyOf = (sessionId) => `alanya:callSessions:${sessionId}`;
const byUserKeyOf = (userId) => `alanya:callSessions:byUser:${Number(userId)}`;
const lockKeyOf = (sessionId) => `alanya:callSessions:lock:${sessionId}`;
const SEQ_KEY = 'alanya:callSessions:seq';

const _sessions = new Map(); // sessionId -> session   (repli mémoire)
const _byUser = new Map();   // userId(Number) -> sessionId
let _seq = 0;

function _toInt(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

function normalizeMode(mode) {
  return mode === 'transfer' ? 'transfer' : 'join';
}

function _nouvelleInvitation(inviteeId, byUserId, inviteId) {
  return {
    userId: inviteeId,
    byUserId,
    inviteId,
    invitedAt: Date.now(),
    timer: null,
    acceptedByDeviceId: null,
    acceptedSocketId: null,
  };
}

function _nouveauTransfert(initiatorId, targetId) {
  return {
    initiatorId,
    targetId,
    state: 'pending',
    readyBy: new Set(),
    readyTimer: null,
    leaveTimer: null,
  };
}

// ── Sérialisation ───────────────────────────────────────────────────────────
// `participants` est une Map et `readyBy` un Set : ni l'un ni l'autre ne
// survit à JSON.stringify. Ils voyagent en tableaux et sont reconstruits à la
// lecture, pour que les appelants gardent `participants.has()`, `.size`,
// `readyBy.add()` — leur code n'a pas à savoir où l'état est rangé.

function _serialise(session) {
  return JSON.stringify({
    ...session,
    participants: [...session.participants.entries()],
    pending: session.pending ? { ...session.pending, timer: !!session.pending.timer } : null,
    transfer: session.transfer ? {
      ...session.transfer,
      readyBy: [...session.transfer.readyBy],
      readyTimer: !!session.transfer.readyTimer,
      leaveTimer: !!session.transfer.leaveTimer,
    } : null,
  });
}

function _deserialise(json) {
  if (!json) return null;
  const brut = JSON.parse(json);
  return {
    ...brut,
    participants: new Map(brut.participants),
    pending: brut.pending ? { ...brut.pending } : null,
    transfer: brut.transfer ? { ...brut.transfer, readyBy: new Set(brut.transfer.readyBy) } : null,
  };
}

// ── Verrou par session ──────────────────────────────────────────────────────

const UNLOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

/**
 * Lit la session, la laisse modifier, la réécrit — le tout sous verrou.
 *
 * `fn` reçoit la session désérialisée et rend soit une valeur à retourner,
 * soit `undefined`. La session est réécrite sauf si `fn` a appelé
 * `ctx.supprimer()`.
 */
async function _mutate(client, sessionId, fn) {
  const cle = lockKeyOf(sessionId);
  const jeton = `${Date.now()}:${Math.random()}`;
  let acquis = false;
  // 50 × 10 ms : au-delà d'une demi-seconde, mieux vaut une opération perdue
  // (et journalisée) qu'un handler socket bloqué indéfiniment.
  for (let i = 0; i < 50 && !acquis; i += 1) {
    acquis = !!(await client.set(cle, jeton, { NX: true, PX: 2000 }));
    if (!acquis) await new Promise((r) => setTimeout(r, 10));
  }
  if (!acquis) {
    console.warn(`[callSessions] verrou indisponible pour ${sessionId} — opération abandonnée`);
    return null;
  }
  try {
    const brut = await client.hGet(keyOf(sessionId), 'data');
    const session = _deserialise(brut);
    let supprimee = false;
    const ctx = { supprimer: () => { supprimee = true; } };
    const sortie = await fn(session, ctx);
    if (supprimee) return sortie;
    if (session) await client.hSet(keyOf(sessionId), 'data', _serialise(session));
    return sortie;
  } finally {
    await runScript(client, UNLOCK, [cle], [jeton]);
  }
}

// ── Minuteurs ───────────────────────────────────────────────────────────────

/**
 * Arme un délai. En mémoire c'est un vrai `setTimeout` ; côté Redis, une ligne
 * `job_queue` — `onExpire` est alors ignoré, le worker appelant lui-même la
 * cascade correspondante.
 */
async function _armer(sessionId, kind, ms, onExpire) {
  const client = getDataClient();
  if (!client) {
    return typeof onExpire === 'function' ? setTimeout(onExpire, ms) : null;
  }
  await cancelByDedupeKey(dedupeOf(sessionId), [kind]);
  await enqueue(kind, { sessionId }, {
    dedupeKey: dedupeOf(sessionId),
    runAfter: new Date(Date.now() + ms),
  });
  return true;
}

async function _desarmer(sessionId, kinds, ...handles) {
  const client = getDataClient();
  if (!client) {
    for (const h of handles) if (h && typeof h !== 'boolean') clearTimeout(h);
    return;
  }
  await cancelByDedupeKey(dedupeOf(sessionId), kinds);
}

// ── Lectures ────────────────────────────────────────────────────────────────

/** Session d'un utilisateur, qu'il y soit participant ou invité en attente. */
async function getByUser(userId) {
  const id = _toInt(userId);
  if (id == null) return null;
  const client = getDataClient();
  if (client) {
    const sessionId = await client.get(byUserKeyOf(id));
    if (!sessionId) return null;
    return _deserialise(await client.hGet(keyOf(sessionId), 'data'));
  }
  const sessionId = _byUser.get(id);
  if (!sessionId) return null;
  return _sessions.get(sessionId) ?? null;
}

async function get(sessionId) {
  if (!sessionId) return null;
  const client = getDataClient();
  if (client) return _deserialise(await client.hGet(keyOf(sessionId), 'data'));
  return _sessions.get(sessionId) ?? null;
}

/** Identifiants des participants effectivement entrés (hors invité en attente). */
function participantIds(session) {
  if (!session) return [];
  return Array.from(session.participants.keys());
}

/** Les autres participants entrés, hors [userId]. */
function peersOf(session, userId) {
  const id = _toInt(userId);
  return participantIds(session).filter((p) => p !== id);
}

/** true si [userId] est l'invité qui sonne encore. */
function isPending(session, userId) {
  const id = _toInt(userId);
  return !!session?.pending && session.pending.userId === id;
}

/**
 * true si [userId] peut déclencher un ajout : pas de session, ou une session à
 * deux dont il est membre et où aucune invitation n'est en vol.
 * Ne vérifie QUE le droit : l'appelant doit s'assurer qu'il est bien en appel.
 */
async function hasAddRight(userId) {
  const id = _toInt(userId);
  const session = await getByUser(id);
  if (!session) return true;
  return !session.pending
    && session.participants.size === 2
    && session.participants.has(id);
}

/** Snapshot testable des timers transfert (leaveTimer uniquement après ready). */
async function getTransferTimerFlags(sessionId) {
  const session = await get(sessionId);
  if (!session?.transfer) {
    return { state: null, hasLeaveTimer: false, hasReadyTimer: false };
  }
  return {
    state: session.transfer.state,
    hasLeaveTimer: !!session.transfer.leaveTimer,
    hasReadyTimer: !!session.transfer.readyTimer,
  };
}

/**
 * true ssi A+B+C présents : initiator, target, et au moins un tiers.
 * Pur : opère sur une session déjà lue.
 */
function canCompleteTransfer(session) {
  if (!session || session.mode !== 'transfer' || !session.transfer) return false;
  const t = session.transfer;
  if (t.state !== 'armed') return false;
  const ids = participantIds(session);
  if (ids.length < 3) return false;
  if (!ids.includes(t.initiatorId)) return false;
  if (!ids.includes(t.targetId)) return false;
  return ids.some((id) => id !== t.initiatorId && id !== t.targetId);
}

// ── Ouverture ───────────────────────────────────────────────────────────────

/**
 * Vérifie que les trois utilisateurs sont libres et écrit la session — en une
 * seule opération. C'est ce qui garantit l'unicité du droit d'ajout : deux
 * `call_add_participant` simultanés sur la même paire créeraient sinon chacun
 * leur session, et l'un des deux invités resterait à sonner dans le vide.
 *
 * KEYS = clés byUser des membres puis de l'invité ; ARGV[1] = clé de session,
 * ARGV[2] = sessionId, ARGV[3] = contenu (opaque, jamais interprété ici).
 */
const OPEN_WITH_PENDING = `
for i = 1, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 1 then return 0 end
end
redis.call('HSET', ARGV[1], 'data', ARGV[3])
for i = 1, #KEYS do
  redis.call('SET', KEYS[i], ARGV[2])
end
return 1
`;

/**
 * Ouvre une session et y place l'invité en attente, en une seule opération.
 * @returns {object|null}
 */
async function openWithPending({
  originCallId = null,
  isVideo = false,
  participants = [],
  inviteeId,
  byUserId,
  mode = 'join',
} = {}) {
  const invitee = _toInt(inviteeId);
  const by = _toInt(byUserId);
  const members = participants.map(_toInt).filter((v) => v != null);
  const normalizedMode = normalizeMode(mode);

  if (invitee == null || by == null || members.length < 2) return null;
  if (members.includes(invitee)) return null;
  if (!members.includes(by)) return null;

  const client = getDataClient();
  const now = Date.now();

  // Le compteur doit être commun à toutes les instances, sinon deux sessions
  // ouvertes en même temps porteraient le même identifiant.
  const seq = client ? await client.incr(SEQ_KEY) : (_seq += 1);
  const sessionId = originCallId != null ? `conf_${originCallId}_${seq}` : `conf_x_${seq}`;

  const session = {
    sessionId,
    originCallId: originCallId != null ? String(originCallId) : null,
    isVideo: !!isVideo,
    mode: normalizedMode,
    createdAt: now,
    addRight: 'locked',
    joins: 0,
    invites: 1,
    participants: new Map(members.map((uid) => [uid, { joinedAt: now }])),
    // Première invitation : son identifiant est le sessionId lui-même, pour
    // que les charges restent celles qu'attendent les apps déjà installées.
    pending: _nouvelleInvitation(invitee, by, sessionId),
    transfer: normalizedMode === 'transfer' ? _nouveauTransfert(by, invitee) : null,
  };

  if (client) {
    const cles = [...members, invitee].map(byUserKeyOf);
    const ok = await runScript(
      client, OPEN_WITH_PENDING, cles,
      [keyOf(sessionId), sessionId, _serialise(session)],
    );
    return Number(ok) === 1 ? session : null;
  }

  for (const uid of [...members, invitee]) {
    if (_byUser.has(uid)) return null;
  }
  _sessions.set(sessionId, session);
  for (const uid of members) _byUser.set(uid, sessionId);
  _byUser.set(invitee, sessionId);
  return session;
}

// ── Invitation ──────────────────────────────────────────────────────────────

/** Arme le délai « personne ne répond » de l'invitation en cours. */
async function armPendingTimer(sessionId, ms, onExpire) {
  const client = getDataClient();
  if (client) {
    const armed = await _armer(sessionId, 'callsession_no_answer', ms, onExpire);
    await _mutate(client, sessionId, (session) => {
      if (session?.pending) session.pending.timer = armed;
    });
    return;
  }
  const session = _sessions.get(sessionId);
  if (!session?.pending) return;
  if (session.pending.timer) clearTimeout(session.pending.timer);
  session.pending.timer = setTimeout(onExpire, ms);
}

/** Retire l'invité d'une session qui continue : retour à deux, droit rendu. */
function _retirerInvitation(session) {
  session.pending = null;
  session.mode = 'join';
  session.transfer = null;
  session.addRight = 'available';
}

/** Minuteurs du repli mémoire ; côté Redis ce sont des booléens, sans effet ici. */
function _arreterMinuteursTransfert(transfer) {
  if (!transfer) return;
  if (transfer.readyTimer) clearTimeout(transfer.readyTimer);
  if (transfer.leaveTimer) clearTimeout(transfer.leaveTimer);
}

/**
 * L'invitation a échoué (refus, sans réponse, annulation, blocage, départ).
 *
 * Tant que personne n'est entré, la session est détruite : les deux
 * participants retrouvent leur appel 1-à-1 vierge. Une fois quelqu'un entré,
 * elle porte l'appel — relais média, propriété d'appareil, historique — et
 * seul l'invité en est retiré.
 *
 * La décision se prend sous le verrou : une invitation soldée à l'instant où
 * l'invité entre ne doit détruire ni sa promotion, ni la session qu'elle vient
 * de faire passer à trois.
 *
 * @returns {Promise<{inviteeId: number, destroyed: boolean}|null>} null si
 *          aucune invitation n'était en attente — déjà promue ou déjà soldée.
 */
async function abortPending(sessionId) {
  const client = getDataClient();
  if (client) {
    const r = await _mutate(client, sessionId, async (session, ctx) => {
      if (!session?.pending) return null;
      const inviteeId = session.pending.userId;
      if (!(session.joins > 0)) {
        await _effacerCles(client, session);
        ctx.supprimer();
        return { inviteeId, destroyed: true };
      }
      _retirerInvitation(session);
      if ((await client.get(byUserKeyOf(inviteeId))) === sessionId) {
        await client.del(byUserKeyOf(inviteeId));
      }
      await client.hDel(keyOf(sessionId), 'leaveArmed');
      return { inviteeId, destroyed: false };
    });
    if (!r) return null;
    await _desarmer(sessionId, KINDS);
    return r;
  }
  const session = _sessions.get(sessionId);
  if (!session?.pending) return null;
  const inviteeId = session.pending.userId;
  if (!(session.joins > 0)) {
    await destroy(sessionId);
    return { inviteeId, destroyed: true };
  }
  if (session.pending.timer) clearTimeout(session.pending.timer);
  _arreterMinuteursTransfert(session.transfer);
  _retirerInvitation(session);
  if (_byUser.get(inviteeId) === sessionId) _byUser.delete(inviteeId);
  return { inviteeId, destroyed: false };
}

/**
 * Greffe une invitation sur une session retombée à deux : le droit d'ajout
 * rendu (docs/transfert_appel.md § 4.5), qui rend le transfert en cascade
 * possible.
 *
 * Refus :
 *   SESSION_GONE — plus de session, ou le demandeur n'en fait plus partie
 *   PENDING      — une invitation est déjà en vol (deux appuis simultanés)
 *   FULL         — déjà trois présents
 *   TARGET_BUSY  — l'invité appartient à une autre session
 *   INVALID      — invité manquant, identique au demandeur ou déjà présent
 *   LOCKED       — verrou de session indisponible
 *
 * @returns {Promise<{session: object}|{refus: string}>}
 */
async function addPending(sessionId, { inviteeId, byUserId, mode = 'join' } = {}) {
  const invitee = _toInt(inviteeId);
  const by = _toInt(byUserId);
  if (invitee == null || by == null || invitee === by) return { refus: 'INVALID' };
  const normalizedMode = normalizeMode(mode);

  const refusDe = (session) => {
    if (!session || !session.participants.has(by)) return 'SESSION_GONE';
    if (session.participants.has(invitee)) return 'INVALID';
    if (session.pending) return 'PENDING';
    if (session.participants.size >= MAX_SESSION_PARTICIPANTS) return 'FULL';
    if (session.participants.size < 2) return 'SESSION_GONE';
    return null;
  };

  // Rend l'objet transfer du tour précédent, dont l'appelant éteint les délais.
  const greffer = (session) => {
    const ancien = session.transfer;
    session.invites = (session.invites || 1) + 1;
    // Une session à deux sans invitation a forcément vu entrer quelqu'un ;
    // celles ouvertes avant l'existence de ce compteur n'en portent pas trace.
    session.joins = Math.max(session.joins || 0, 1);
    session.mode = normalizedMode;
    session.addRight = 'locked';
    session.pending = _nouvelleInvitation(invitee, by, `${session.sessionId}_r${session.invites}`);
    session.transfer = normalizedMode === 'transfer' ? _nouveauTransfert(by, invitee) : null;
    return ancien;
  };

  const client = getDataClient();
  if (client) {
    const r = await _mutate(client, sessionId, async (session) => {
      const refus = refusDe(session);
      if (refus) return { refus };
      if (!(await client.set(byUserKeyOf(invitee), sessionId, { NX: true }))) {
        return { refus: 'TARGET_BUSY' };
      }
      try {
        const ancien = greffer(session);
        // Posé par le transfert précédent : sans l'effacer, le HSETNX de
        // `registerTransferReady` échouerait et le nouveau transfert ne
        // s'armerait jamais.
        await client.hDel(keyOf(sessionId), 'leaveArmed');
        return { session, avaitTransfert: !!ancien };
      } catch (err) {
        await client.del(byUserKeyOf(invitee));
        throw err;
      }
    });
    if (!r) return { refus: 'LOCKED' };
    if (r.refus) return { refus: r.refus };
    if (r.avaitTransfert) {
      await _desarmer(sessionId, ['callsession_ready_timeout', 'callsession_auto_leave']);
    }
    return { session: r.session };
  }

  // Repli mémoire : contrôle et écriture sans aucun `await` entre les deux.
  const session = _sessions.get(sessionId);
  const refus = refusDe(session);
  if (refus) return { refus };
  if (_byUser.has(invitee)) return { refus: 'TARGET_BUSY' };
  _arreterMinuteursTransfert(greffer(session));
  _byUser.set(invitee, sessionId);
  return { session };
}

/**
 * L'invité accepte : participant + addRight consommé.
 * En mode transfer → state joined (readyTimer armé par le handler).
 * @returns {object|null}
 */
async function promotePending(sessionId) {
  const appliquer = (session) => {
    if (!session?.pending) return null;
    if (session.participants.size >= MAX_SESSION_PARTICIPANTS) return null;
    const inviteeId = session.pending.userId;
    // L'identifiant de son invitation est celui que son téléphone a donné à
    // CallKit : les notifications de fin devront viser celui-là.
    session.participants.set(inviteeId, {
      joinedAt: Date.now(),
      inviteId: session.pending.inviteId || session.sessionId,
    });
    session.pending = null;
    session.addRight = 'consumed';
    session.joins = (session.joins || 0) + 1;
    if (session.mode === 'transfer' && session.transfer) {
      session.transfer.state = 'joined';
      session.transfer.targetId = inviteeId;
    }
    return { session, inviteeId };
  };

  const client = getDataClient();
  if (client) {
    const r = await _mutate(client, sessionId, (session) => appliquer(session));
    if (!r) return null;
    await _desarmer(sessionId, ['callsession_no_answer']);
    await client.set(byUserKeyOf(r.inviteeId), sessionId);
    return r.session;
  }
  const session = _sessions.get(sessionId);
  if (session?.pending?.timer) { clearTimeout(session.pending.timer); session.pending.timer = null; }
  const r = appliquer(session);
  if (!r) return null;
  _byUser.set(r.inviteeId, sessionId);
  return r.session;
}

/**
 * Note l'appareil qui a accepté l'invitation en attente.
 *
 * `confJoin` écrivait directement sur l'objet rendu par `getByUser`. En mode
 * mémoire ça marchait ; en mode Redis, `getByUser` rend un objet fraîchement
 * désérialisé, donc l'écriture partait dans une copie jetable et la garde qui
 * relit ce champ voyait toujours `null`. Défense en profondeur devenue
 * inopérante — et invisible aux tests, qui tournent sans REDIS_URL.
 *
 * @returns {boolean} false si un *autre* appareil a déjà accepté.
 */
async function markPendingAccepted(sessionId, { deviceId, socketId = null } = {}) {
  const appliquer = (session) => {
    if (!session?.pending) return null;
    const deja = session.pending.acceptedByDeviceId;
    if (deja && deja !== deviceId) return null;
    session.pending.acceptedByDeviceId = deviceId;
    session.pending.acceptedSocketId = socketId;
    return { ok: true };
  };

  const client = getDataClient();
  if (client) {
    return !!(await _mutate(client, sessionId, appliquer));
  }
  return !!appliquer(_sessions.get(sessionId));
}

// ── Transfert ───────────────────────────────────────────────────────────────

/**
 * Après promotePending en transfer : marque joined et pose le délai média.
 * Idempotent si déjà joined/armed.
 */
async function markTransferJoined(sessionId, ms, onExpire) {
  const client = getDataClient();
  if (client) {
    const doitArmer = await _mutate(client, sessionId, (session) => {
      if (!session || session.mode !== 'transfer' || !session.transfer) return false;
      if (session.transfer.state === 'armed' || session.transfer.state === 'completed') return false;
      session.transfer.state = 'joined';
      session.transfer.readyTimer = ms != null;
      return ms != null;
    });
    if (doitArmer) await _armer(sessionId, 'callsession_ready_timeout', ms, onExpire);
    return get(sessionId);
  }
  const session = _sessions.get(sessionId);
  if (!session || session.mode !== 'transfer' || !session.transfer) return null;
  if (session.transfer.state === 'armed' || session.transfer.state === 'completed') return session;
  session.transfer.state = 'joined';
  if (session.transfer.readyTimer) clearTimeout(session.transfer.readyTimer);
  session.transfer.readyTimer = ms != null && typeof onExpire === 'function'
    ? setTimeout(onExpire, ms) : null;
  return session;
}

/**
 * Enregistre un call_conf_ready. N'arme le délai de sortie qu'une seule fois.
 *
 * Contrat strict :
 * - state doit être `joined` (après call_conf_join / promotePending)
 * - JAMAIS de leaveTimer en `pending` (invitation) ni en `joined` sans ready
 * - seul un reporter restant (ni initiateur, ni cible) avec peerId === targetId
 * - le délai est armé au plus une fois par session
 *
 * L'unicité repose sur `HSETNX` côté Redis : poser un champ seulement s'il est
 * absent EST la sémantique « armer une seule fois », nativement atomique. Deux
 * `call_conf_ready` simultanés ne peuvent donc pas armer deux sorties
 * automatiques — l'initiateur serait retiré deux fois de l'appel.
 *
 * @returns {{ ok: boolean, armed: boolean, reason?: string, session?: object }}
 */
async function registerTransferReady({ sessionId, reporterId, peerId, leaveTimerMs, onLeave }) {
  const session = await get(sessionId);
  if (!session || session.mode !== 'transfer' || !session.transfer) {
    return { ok: false, armed: false, reason: 'NO_TRANSFER' };
  }
  const t = session.transfer;
  if (t.state === 'armed' || t.state === 'completed' || t.state === 'cancelled') {
    return { ok: true, armed: false, reason: 'ALREADY_SETTLED', session };
  }
  if (t.state !== 'joined') return { ok: false, armed: false, reason: 'NOT_JOINED' };
  if (t.leaveTimer) return { ok: true, armed: false, reason: 'ALREADY_ARMED', session };

  const reporter = _toInt(reporterId);
  const peer = _toInt(peerId);
  if (reporter == null || peer == null) return { ok: false, armed: false, reason: 'INVALID' };
  if (peer !== t.targetId) return { ok: false, armed: false, reason: 'WRONG_PEER' };
  if (reporter === t.initiatorId || reporter === t.targetId) {
    return { ok: false, armed: false, reason: 'INVALID_REPORTER' };
  }
  if (!session.participants.has(reporter) || !session.participants.has(peer)) {
    return { ok: false, armed: false, reason: 'NOT_MEMBER' };
  }

  const client = getDataClient();
  if (client) {
    // Le gagnant du HSETNX est le seul à armer.
    const gagnant = await client.hSetNX(keyOf(sessionId), 'leaveArmed', '1');
    if (!gagnant) {
      return { ok: true, armed: false, reason: 'ALREADY_ARMED', session: await get(sessionId) };
    }
    await _desarmer(sessionId, ['callsession_ready_timeout']);
    await _armer(sessionId, 'callsession_auto_leave', leaveTimerMs, onLeave);
    const maj = await _mutate(client, sessionId, (s) => {
      if (!s?.transfer) return null;
      s.transfer.readyBy = new Set([...s.transfer.readyBy, reporter]);
      s.transfer.readyTimer = false;
      s.transfer.state = 'armed';
      s.transfer.armedAt = Date.now();
      s.transfer.leaveTimer = true;
      return s;
    });
    return { ok: true, armed: true, session: maj || await get(sessionId) };
  }

  t.readyBy.add(reporter);
  if (t.readyTimer) { clearTimeout(t.readyTimer); t.readyTimer = null; }
  t.state = 'armed';
  t.armedAt = Date.now();
  t.leaveTimer = typeof onLeave === 'function' ? setTimeout(onLeave, leaveTimerMs) : null;
  return { ok: true, armed: true, session };
}

async function clearTransferTimers(sessionId) {
  const client = getDataClient();
  if (client) {
    await _desarmer(sessionId, ['callsession_ready_timeout', 'callsession_auto_leave']);
    await _mutate(client, sessionId, (s) => {
      if (!s?.transfer) return;
      s.transfer.readyTimer = false;
      s.transfer.leaveTimer = false;
    });
    return;
  }
  const session = _sessions.get(sessionId);
  if (!session?.transfer) return;
  if (session.transfer.readyTimer) { clearTimeout(session.transfer.readyTimer); session.transfer.readyTimer = null; }
  if (session.transfer.leaveTimer) { clearTimeout(session.transfer.leaveTimer); session.transfer.leaveTimer = null; }
}

async function cancelTransfer(sessionId, reason = 'cancelled') {
  await clearTransferTimers(sessionId);
  const client = getDataClient();
  if (client) {
    return _mutate(client, sessionId, (s) => {
      if (!s?.transfer) return null;
      s.transfer.state = 'cancelled';
      s.transfer.cancelReason = reason;
      return s;
    });
  }
  const session = _sessions.get(sessionId);
  if (!session?.transfer) return null;
  session.transfer.state = 'cancelled';
  session.transfer.cancelReason = reason;
  return session;
}

async function completeTransfer(sessionId) {
  await clearTransferTimers(sessionId);
  const client = getDataClient();
  if (client) {
    return _mutate(client, sessionId, (s) => {
      if (!s?.transfer) return null;
      s.transfer.state = 'completed';
      return s;
    });
  }
  const session = _sessions.get(sessionId);
  if (!session?.transfer) return null;
  session.transfer.state = 'completed';
  return session;
}

// ── Départs ─────────────────────────────────────────────────────────────────

/**
 * Retire un participant. Annule les timers de transfert.
 * @returns {{remaining: number[], destroyed: boolean, wasPending: boolean, hadPendingInvitee: number|null}}
 */
async function removeParticipant(sessionId, userId) {
  const vide = { remaining: [], destroyed: false, wasPending: false, hadPendingInvitee: null };
  const id = _toInt(userId);
  if (id == null) return vide;

  const session = await get(sessionId);
  if (!session) return vide;

  const hadPendingInvitee = session.pending ? session.pending.userId : null;

  if (isPending(session, id)) {
    const remaining = participantIds(session);
    const solde = await abortPending(sessionId);
    return {
      remaining,
      destroyed: solde ? solde.destroyed : false,
      wasPending: true,
      hadPendingInvitee: id,
    };
  }

  // Annuler le transfert si l'un des acteurs part (ou si B part pendant armed).
  if (session.transfer && session.transfer.state !== 'completed') {
    await clearTransferTimers(sessionId);
  }

  const client = getDataClient();
  if (client) {
    const r = await _mutate(client, sessionId, (s) => {
      if (!s) return null;
      if (s.transfer && s.transfer.state !== 'completed'
        && (s.transfer.state === 'armed' || s.transfer.state === 'joined')) {
        s.transfer.state = 'cancelled';
      }
      s.participants.delete(id);
      if (s.participants.size === 2 && !s.pending) s.addRight = 'available';
      const restants = participantIds(s);
      const pendingLeft = s.pending?.userId ?? null;
      return { restants, aDetruire: s.participants.size < 2, pendingLeft };
    });
    if (!r) return vide;
    await client.del(byUserKeyOf(id));
    if (r.aDetruire) {
      await destroy(sessionId);
      return {
        remaining: r.restants,
        destroyed: true,
        wasPending: false,
        hadPendingInvitee: hadPendingInvitee ?? r.pendingLeft,
      };
    }
    return { remaining: r.restants, destroyed: false, wasPending: false, hadPendingInvitee: null };
  }

  const s = _sessions.get(sessionId);
  if (s.transfer && s.transfer.state !== 'completed'
    && (s.transfer.state === 'armed' || s.transfer.state === 'joined')) {
    s.transfer.state = 'cancelled';
  }
  s.participants.delete(id);
  _byUser.delete(id);
  if (s.participants.size === 2 && !s.pending) s.addRight = 'available';
  if (s.participants.size < 2) {
    const remaining = participantIds(s);
    const pendingLeft = s.pending?.userId ?? null;
    await destroy(sessionId);
    return {
      remaining, destroyed: true, wasPending: false,
      hadPendingInvitee: hadPendingInvitee ?? pendingLeft,
    };
  }
  return { remaining: participantIds(s), destroyed: false, wasPending: false, hadPendingInvitee: null };
}

/** Supprime une session et les clés `byUser` de ses membres et de son invité. */
async function _effacerCles(client, session) {
  const cles = [...session.participants.keys()].map(byUserKeyOf);
  if (session.pending) cles.push(byUserKeyOf(session.pending.userId));
  if (cles.length) await client.del(cles);
  await client.del(keyOf(session.sessionId));
}

async function destroy(sessionId) {
  const client = getDataClient();
  if (client) {
    const session = await get(sessionId);
    await cancelByDedupeKey(dedupeOf(sessionId), KINDS);
    if (session) await _effacerCles(client, session);
    else await client.del(keyOf(sessionId));
    return;
  }
  const session = _sessions.get(sessionId);
  if (!session) return;
  if (session.pending?.timer) clearTimeout(session.pending.timer);
  if (session.transfer?.readyTimer) clearTimeout(session.transfer.readyTimer);
  if (session.transfer?.leaveTimer) clearTimeout(session.transfer.leaveTimer);
  for (const uid of session.participants.keys()) _byUser.delete(uid);
  if (session.pending) _byUser.delete(session.pending.userId);
  _sessions.delete(sessionId);
}

/** Remise à zéro — tests du repli mémoire uniquement. */
function _reset() {
  for (const session of _sessions.values()) {
    if (session.pending?.timer) clearTimeout(session.pending.timer);
    if (session.transfer?.readyTimer) clearTimeout(session.transfer.readyTimer);
    if (session.transfer?.leaveTimer) clearTimeout(session.transfer.leaveTimer);
  }
  _sessions.clear();
  _byUser.clear();
  _seq = 0;
}

module.exports = {
  MAX_SESSION_PARTICIPANTS,
  TRANSFER_READY_TIMEOUT_MS,
  TRANSFER_AUTO_LEAVE_MS,
  KINDS,
  getByUser,
  get,
  participantIds,
  peersOf,
  isPending,
  hasAddRight,
  normalizeMode,
  openWithPending,
  armPendingTimer,
  abortPending,
  addPending,
  promotePending,
  markPendingAccepted,
  markTransferJoined,
  registerTransferReady,
  getTransferTimerFlags,
  canCompleteTransfer,
  cancelTransfer,
  completeTransfer,
  clearTransferTimers,
  removeParticipant,
  destroy,
  _reset,
};
