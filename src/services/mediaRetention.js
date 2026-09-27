/**
 * Médias de message — purge des fichiers physiques après rétention.
 *
 * Le message survit, le fichier non. Passé sa rétention, le fichier est
 * supprimé (disque et Backblaze, voir `deleteMediaFile`) et `message.mediaUrl`
 * est vidée — le message reste visible dans la conversation, seul le média
 * n'est plus servable depuis le serveur. Un appareil qui l'avait déjà
 * téléchargé garde sa copie locale indéfiniment (ce module ne touche jamais
 * au téléphone).
 *
 * ── Deux durées ──
 *
 * La durée standard (`mediaDays`, 30 jours) vaut pour tout le monde. La
 * durée longue (`plusDays`, 365 jours) est celle d'Alanya Plus : un média la
 * garde tant qu'AU MOINS UNE personne de sa discussion — expéditeur compris —
 * y a droit (`mediaRetentionCovered`, billing/rules.js). Le fichier est
 * unique ; c'est au téléphone d'un membre non abonné de s'arrêter à la durée
 * standard (`mediaRetentionDays` dans ses droits).
 *
 * C'est l'état de l'abonnement AU MOMENT DE LA PURGE qui compte : un compte
 * qui s'abonne prolonge les médias encore présents, un compte dont les
 * données payantes sont purgées les ramène à la durée standard.
 *
 * Backblaze ne sait appliquer qu'une durée par préfixe : c'est pourquoi la
 * décision est prise ici, message par message. La règle de cycle de vie du
 * bucket (366 jours sur `media/`) n'est qu'un filet.
 *
 * ── Deux garde-fous ──
 *
 * Une suppression est définitive. La purge automatique s'arrête donc, sans
 * rien supprimer :
 *  - si l'état des abonnements est illisible ;
 *  - si elle s'apprête à supprimer beaucoup plus que d'habitude — un
 *    interrupteur payant éteint par erreur, une durée mal saisie ou un bug
 *    de lecture des abonnements effaceraient d'un coup des mois de médias
 *    d'abonnés. Un super-admin la relance alors à la main depuis l'espace
 *    des purges, ce qui vaut confirmation.
 *
 * Le garde 410 suit : il n'annonce un média expiré qu'au-delà du plafond de
 * la dernière purge menée à terme (`dernierPlafondApplique`), jamais d'une
 * règle que la purge n'a pas encore été autorisée à appliquer.
 *
 * Séparé de `messageController` pour la même raison que `tripRetention` est
 * séparé de `tripWorkers` : la purge nocturne n'a besoin ni de socket, ni de
 * notifications, ni du reste de la machinerie d'envoi de message.
 */

const pool = require('../config/db');
const policy = require('../constants/mediaRetentionPolicy');
const { PHASE } = require('../constants/billing');
const { ACCOUNT_TYPE } = require('../constants/accountTypes');
const { deleteMediaFile } = require('../utils/mediaFile');
const { phaseAt, billingTesterIds } = require('./billing/rules');
const { getBillingSettings } = require('./billing/settings');

const BATCH_SIZE = 500;

/** Nuits de référence, et facteur au-delà duquel une nuit est anormale. */
const NUITS_DE_REFERENCE = 7;
const FACTEUR_ALERTE = 3;

// ── Durées et contexte ──────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;
let _durees = null;

/**
 * Durées réglées depuis l'espace des purges (purge `media`), à défaut celles
 * de l'environnement. Gardées une minute : le garde 410 et les droits du
 * téléphone les consultent à chaque requête.
 */
async function lireDureesMedias() {
  if (_durees && Date.now() - _durees.lu < CACHE_TTL_MS) return _durees.valeur;
  // Chargé à l'appel : le registre des purges charge ce module de la même façon.
  const { resolveOptions } = require('./purgeRegistry');
  const o = await resolveOptions('media');
  const valeur = { standardDays: o.mediaDays, plusDays: o.plusDays };
  _durees = { lu: Date.now(), valeur };
  return valeur;
}

/**
 * Ce que la purge doit savoir avant de supprimer quoi que ce soit : les deux
 * durées, et qui peut prétendre à la longue (`paliers`) :
 *  - `aucun`    : tout le monde à la durée standard — phase gratuite ou de
 *                 grâce, module d'abonnement absent, ou durée longue qui n'est
 *                 pas plus longue ;
 *  - `tous`     : phase payante, la règle s'applique à chacun ;
 *  - `testeurs` : phase gratuite, mais les comptes BILLING_TEST_USERS voient
 *                 la phase payante — eux seuls peuvent être couverts.
 *
 * Un état d'abonnement illisible fait échouer la lecture, donc la purge :
 * dans le doute, rien n'est supprimé. Seule l'absence des tables (migration
 * 080 non appliquée) est tranchée : sans elles, personne n'est abonné.
 */
async function lireContexte(
  { standardDays, plusDays } = {},
  { lireReglages = getBillingSettings, env = process.env } = {},
) {
  const standard = standardDays ?? policy.RETENTION.mediaDays;
  const longue = Math.max(standard, plusDays ?? policy.RETENTION.plusDays);

  let phase = PHASE.FREE;
  let abonnement = true;
  try {
    phase = phaseAt(await lireReglages());
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    abonnement = false;
  }

  const testeurs = [...billingTesterIds(env)];
  let paliers = 'aucun';
  if (abonnement && longue > standard) {
    if (phase === PHASE.PAID) paliers = 'tous';
    else if (testeurs.length) paliers = 'testeurs';
  }
  return {
    standardDays: standard,
    plusDays: longue,
    phase,
    paliers,
    testeurs: paliers === 'testeurs' ? testeurs : [],
  };
}

/**
 * Durée au-delà de laquelle plus personne ne peut prétendre à un média.
 *
 * Les testeurs n'y comptent pas : en phase gratuite, les inclure porterait le
 * plafond à la durée longue pour TOUT le monde, et les médias purgés entre
 * les deux durées répondraient 404 au lieu de 410 — que l'application prend
 * pour une panne passagère. Un testeur ne peut donc pas éprouver cette
 * fenêtre-là ; la purge, elle, l'épargne bien.
 */
const plafondDe = (ctx) => (ctx.paliers === 'tous' ? ctx.plusDays : ctx.standardDays);

const plafondParDefaut = () => Math.max(policy.RETENTION.mediaDays, policy.RETENTION.plusDays);

/**
 * Plafond de la dernière purge `media` menée à terme, ou `null`.
 *
 * Le plafond annoncé ne descend pas avant que la purge ait réellement tourné
 * à la nouvelle durée. Sans ça, un interrupteur payant éteint par erreur
 * ferait répondre 410 tout de suite sur les médias d'abonnés — que le
 * téléphone tient pour définitivement perdus — alors même que le garde-fou
 * de volume a suspendu leur suppression. Un média encore présent reste donc
 * servi tant que la purge n'a pas été confirmée.
 */
async function dernierPlafondApplique(db = pool) {
  try {
    const [rows] = await db.execute(
      `SELECT result FROM purge_runs
        WHERE name = 'media' AND ok = 1
        ORDER BY id DESC LIMIT 1`,
    );
    if (!rows.length) return null;
    const res = typeof rows[0].result === 'string' ? JSON.parse(rows[0].result) : rows[0].result;
    return Number(res?.plafondJours) || null;
  } catch {
    return null;
  }
}

/** Plafond servi : jamais sous celui de la dernière purge menée à terme. */
const plafondServi = (ctx, dernier) => Math.max(plafondDe(ctx), dernier ?? 0);

let _plafond = null;
let _lecturePlafond = null;

/** Relit le plafond. Jette si l'état des abonnements est illisible. */
async function rafraichirPlafond() {
  const ctx = await lireContexte(await lireDureesMedias());
  _plafond = { jours: plafondServi(ctx, await dernierPlafondApplique()), lu: Date.now() };
  return _plafond.jours;
}

/**
 * Plafond de conservation, lu sans attendre : pour le garde 410, qui ne peut
 * pas interroger la base à chaque requête. La valeur connue est rendue, et
 * relue en arrière-plan au plus une fois par minute.
 *
 * Avant la première lecture, ou si elle échoue, le plafond est le plus long
 * possible. Un 410 est définitif pour le téléphone, et mis en cache une
 * journée : l'annoncer à tort ferait perdre un média d'abonné, alors qu'un
 * média laissé passer à tort aboutit à un 404 du stockage, qui se rattrape.
 */
function plafondMedias() {
  const perime = !_plafond || Date.now() - _plafond.lu > CACHE_TTL_MS;
  if (perime && !_lecturePlafond) {
    _lecturePlafond = rafraichirPlafond()
      .catch((e) => {
        console.warn('[Media] plafond de conservation illisible, valeur précédente gardée:', e.message);
        // Pas de nouvelle tentative avant une minute.
        _plafond = { jours: _plafond?.jours ?? plafondParDefaut(), lu: Date.now() };
      })
      .finally(() => { _lecturePlafond = null; });
  }
  return _plafond ? _plafond.jours : plafondParDefaut();
}

// ── Sélection ───────────────────────────────────────────────────────────────

/**
 * Le compte `u` (users), avec sa ligne `s` (subscriber, en jointure externe),
 * garde-t-il ses médias la durée longue ?
 *
 * ⚠ Recopie SQL de `mediaRetentionCovered` (billing/rules.js), phase payante
 * supposée : le prédicat ne s'en sert qu'alors. Toute modification doit être
 * reportée des deux côtés.
 */
const compteCouvert = (ctx) => {
  const testeurs = ctx.paliers === 'testeurs'
    ? { sql: `u.alanyaID IN (${ctx.testeurs.map(() => '?').join(',')}) AND `, params: ctx.testeurs }
    : { sql: '', params: [] };
  return {
    sql: `${testeurs.sql}(u.type_compte >= 1 OR u.account_type = ?
            OR (s.purged_at IS NULL AND s.current_end IS NOT NULL
                AND (s.current_end > NOW() OR s.purge_after IS NULL OR s.purge_after > NOW())))`,
    params: [...testeurs.params, ACCOUNT_TYPE.OFFICIEL],
  };
};

/**
 * Prédicat « ce média a dépassé sa rétention », sur un `message` aliasé `m`.
 * Il n'existe pas de colonne dédiée à l'instant d'upload : l'upload physique
 * se termine toujours AVANT la création de la ligne `message` (le client
 * uploade, reçoit une URL, puis envoie le message avec cette URL) — `sendAt`
 * est donc une référence sûre, au pire légèrement postérieure à l'upload réel.
 *
 * Avec des paliers, un média entre les deux durées n'est purgé que si
 * personne de sa discussion n'est couvert : ni l'expéditeur, ni un membre
 * actuel. Un média gardé ne correspond pas au prédicat, donc la boucle par
 * lots ne le revoit jamais et s'arrête bien.
 *
 * Seuls les médias de discussion expirent : ceux dont l'adresse désigne
 * `/uploads/media/`. Un message d'accueil ou de diffusion pointe vers un média
 * officiel (`official/`, bucket public), qui n'expire jamais et que des
 * milliers de messages partagent ; supprimer le fichier au terme du premier
 * message les casserait tous.
 *
 * `ctx` vient de `lireContexte`. Un appel avec `{ mediaDays }` seul garde la
 * forme d'avant les paliers.
 */
const expiredMediaWhere = (ctx = {}) => {
  const standard = ctx.standardDays ?? ctx.mediaDays ?? policy.RETENTION.mediaDays;
  const base = {
    sql: `m.mediaUrl IS NOT NULL AND m.mediaUrl LIKE '%/uploads/media/%'
          AND m.sendAt < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    params: [standard],
  };
  if (!ctx.paliers || ctx.paliers === 'aucun') return base;

  const couvert = compteCouvert(ctx);
  return {
    sql: `${base.sql}
          AND (m.sendAt < DATE_SUB(NOW(), INTERVAL ? DAY)
               OR (NOT EXISTS (SELECT 1 FROM users u
                                 LEFT JOIN subscriber s ON s.alanyaID = u.alanyaID
                                WHERE u.alanyaID = m.senderID AND ${couvert.sql})
                   AND NOT EXISTS (SELECT 1 FROM conv_participants cp
                                     JOIN users u ON u.alanyaID = cp.alanyaID
                                     LEFT JOIN subscriber s ON s.alanyaID = u.alanyaID
                                    WHERE cp.conversID = m.conversationID AND ${couvert.sql})))`,
    params: [standard, ctx.plusDays, ...couvert.params, ...couvert.params],
  };
};

/** Ce que la purge supprimerait maintenant : nombre, taille, plus ancien. */
async function countPurgeable(db, ctx) {
  const cible = expiredMediaWhere(ctx);
  const [rows] = await db.execute(
    `SELECT COUNT(*) AS fichiers,
            COALESCE(SUM(m.mediaSize), 0) AS octets,
            MIN(m.sendAt) AS plusAncien
       FROM message m
      WHERE ${cible.sql}`,
    cible.params,
  );
  return {
    fichiers: Number(rows[0].fichiers) || 0,
    octets: Number(rows[0].octets) || 0,
    plusAncien: rows[0].plusAncien,
  };
}

// ── Garde-fou de volume ─────────────────────────────────────────────────────

/**
 * Nombre de fichiers au-delà duquel la purge automatique s'arrête : le plus
 * grand du plancher réglé et de trois fois la moyenne des dernières nuits.
 * Sans journal lisible, le plancher seul.
 */
async function seuilDeLaNuit(db, plancher) {
  let moyenne = 0;
  try {
    const [rows] = await db.execute(
      `SELECT result FROM purge_runs
        WHERE name = 'media' AND ok = 1 AND trigger_source = 'auto'
        ORDER BY id DESC LIMIT ${NUITS_DE_REFERENCE}`,
    );
    const nuits = rows.map((r) => {
      const res = typeof r.result === 'string' ? JSON.parse(r.result) : r.result;
      return Number(res?.files) || 0;
    });
    if (nuits.length) moyenne = nuits.reduce((a, b) => a + b, 0) / nuits.length;
  } catch (e) {
    console.warn('[Media] journal des purges illisible, plancher seul:', e.message);
  }
  return Math.max(plancher, Math.ceil(FACTEUR_ALERTE * moyenne));
}

class PurgeSuspendue extends Error {
  constructor(aSupprimer, seuil) {
    super(
      `Purge suspendue : ${aSupprimer} fichiers à supprimer, au-delà du seuil de ${seuil}. `
      + "Vérifiez les durées et l'état de l'offre payante, puis lancez la purge à la main "
      + 'pour confirmer.',
    );
    this.code = 'MEDIA_PURGE_SUSPENDED';
    this.aSupprimer = aSupprimer;
    this.seuil = seuil;
  }
}

// ── Exécution ───────────────────────────────────────────────────────────────

/**
 * Purge un lot de médias expirés. Renvoie le nombre de lignes traitées.
 *
 * `supprimerFichier` est injectable : les tests n'ont rien à faire chez
 * Backblaze, et le `.env` de développement y donne accès.
 */
const purgeExpiredMediaBatch = async (db = pool, ctx = {}, { supprimerFichier = deleteMediaFile } = {}) => {
  const cible = expiredMediaWhere(ctx);
  const [rows] = await db.execute(
    // Alias `m` obligatoire : `expiredMediaWhere()` qualifie ses colonnes
    // (`m.mediaUrl`, `m.sendAt`) pour rester utilisable dans une jointure.
    `SELECT m.msgID, m.mediaUrl FROM message m WHERE ${cible.sql} LIMIT ${BATCH_SIZE}`,
    cible.params,
  );
  if (rows.length === 0) return 0;

  for (const row of rows) {
    supprimerFichier(row.mediaUrl);
  }

  const ids = rows.map((r) => r.msgID);
  await db.execute(
    `UPDATE message SET mediaUrl = NULL WHERE msgID IN (${ids.map(() => '?').join(',')})`,
    ids,
  );
  return rows.length;
};

/**
 * Purge nocturne complète : traite tous les lots expirés, pas seulement le
 * premier.
 *
 * @param {object} [opts]
 * @param {number} [opts.mediaDays]   durée standard (réglage de l'admin)
 * @param {number} [opts.plusDays]    durée longue
 * @param {number} [opts.alertFloor]  plancher du garde-fou de volume
 * @param {string} [opts.trigger]     `auto` (balayage) ou `manual` (super-admin,
 *                                    qui confirme : pas de garde-fou de volume)
 * @param {object} [opts.contexte]    contexte déjà lu (tests)
 */
const runNightlyMediaPurge = async (db = pool, opts = {}) => {
  const {
    trigger = 'auto',
    alertFloor = policy.RETENTION.alertFloor,
    supprimerFichier = deleteMediaFile,
  } = opts;
  const ctx = opts.contexte
    ?? await lireContexte({ standardDays: opts.mediaDays, plusDays: opts.plusDays });

  let seuil = null;
  if (trigger === 'auto') {
    const { fichiers } = await countPurgeable(db, ctx);
    seuil = await seuilDeLaNuit(db, alertFloor);
    if (fichiers > seuil) throw new PurgeSuspendue(fichiers, seuil);
  }

  let total = 0;
  let n;
  do {
    n = await purgeExpiredMediaBatch(db, ctx, { supprimerFichier });
    total += n;
  } while (n === BATCH_SIZE);
  if (total) {
    console.log(`[Media] purge : ${total} fichier(s)`);
  }
  return {
    files: total,
    paliers: ctx.paliers,
    standardDays: ctx.standardDays,
    plusDays: ctx.plusDays,
    // Lu par `dernierPlafondApplique` : le garde 410 peut désormais
    // descendre à ce plafond, la purge ayant été menée à terme.
    plafondJours: plafondDe(ctx),
    ...(seuil !== null ? { seuil } : {}),
  };
};

/** Vide les caches de lecture. Pour les tests uniquement. */
function _resetCaches() {
  _durees = null;
  _plafond = null;
  _lecturePlafond = null;
}

module.exports = {
  BATCH_SIZE,
  PurgeSuspendue,
  lireDureesMedias,
  lireContexte,
  plafondDe,
  plafondServi,
  dernierPlafondApplique,
  plafondMedias,
  rafraichirPlafond,
  expiredMediaWhere,
  countPurgeable,
  seuilDeLaNuit,
  purgeExpiredMediaBatch,
  runNightlyMediaPurge,
  _resetCaches,
};
