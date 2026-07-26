const pool = require('./../config/db');
const { systemPreviewFromContent } = require('./messagePreview');

/**
 * Messages système de groupe (« X a ajouté Y »).
 *
 * Quatre partis pris qui doivent le rester :
 *
 * 1. Le `content` est un **payload JSON machine-lisible**, jamais une phrase
 *    pré-rendue : le fil doit s'afficher dans la langue du LECTEUR, pas dans
 *    celle de l'acteur. Le client traduit via SystemEventPayload.label().
 *
 * 2. Les noms (`byName`, `names`) sont **dénormalisés à l'écriture**. Sans
 *    cela, le nom d'un membre exclu n'est plus résoluble (il ne figure plus
 *    dans `participants`) et le fil afficherait « a retiré (inconnu) ». Même
 *    raisonnement que `message.replyToContent`.
 *
 * 3. **Aucun unread, aucune push.** Un événement de groupe met à jour l'aperçu
 *    de la conversation (le fil remonte dans la liste) mais ne doit pas faire
 *    sonner un téléphone ni gonfler un badge. Un client hors ligne les récupère
 *    par le delta `POST /messages/sync` comme n'importe quel message.
 *    Corollaire : l'argument « push silencieuse pour permettre l'accusé de
 *    remise » (notificationFilter.js) ne s'applique pas ici, puisqu'il n'y a
 *    aucun accusé à collecter.
 *
 * 4. Un échec d'écriture **ne fait jamais échouer la mutation**. Le message
 *    système est une trace ; le retrait ou le renommage, lui, est déjà commis.
 */

const SYSTEM_MESSAGE_TYPE = 6;

/**
 * Coupe-circuit de déploiement.
 *
 * Une app en circulation qui ne connaît pas encore le type 6 afficherait le
 * payload JSON brut dans une bulle. Le rendu client a été livré AVANT cette
 * émission (commit b37eb5a côté Talky) précisément pour éviter ça, mais un
 * utilisateur qui n'a pas mis à jour reste exposé.
 *
 * Coupe-circuit (défaut actif, `=0` pour éteindre) plutôt qu'opt-in : un
 * drapeau que personne ne pense à activer laisse la fonctionnalité
 * silencieusement morte, et les écrans de gestion de groupe s'appuient sur ces
 * traces. L'aperçu de la liste (`lastMessage`) reste correct dans tous les cas,
 * puisqu'il est calculé serveur.
 */
const SYSTEM_MESSAGES_ENABLED = process.env.GROUP_SYSTEM_MESSAGES !== '0';

/** Même projection que MSG_SELECT (socket/handlers/chat/messageSend.js). */
const MSG_SELECT = `
  SELECT m.*, u.nom AS sender_nom, u.pseudo AS sender_pseudo, u.avatar_url AS sender_avatar,
         p.timeZone AS messageTz, p.decalageHoraire AS messageTzOffset
  FROM message m
  JOIN users u ON m.senderID = u.alanyaID
  LEFT JOIN pays p ON u.idPays = p.idPays
`;

/**
 * Insère un message système et le diffuse aux membres.
 *
 * @param {object}   opts
 * @param {number}   opts.conversationID
 * @param {number}   opts.actorID        auteur de l'action — devient `senderID`,
 *                                       ce qui garde la jointure `JOIN users`
 *                                       de getMessages valide (pas de colonne
 *                                       nullable à ajouter au schéma).
 * @param {string}   opts.event          `member_added`, `group_renamed`, …
 * @param {object}   [opts.payload]      champs additionnels (ids, names, value…)
 * @param {object}   [opts.io]
 * @param {number[]} [opts.notifyExtra]  ids à notifier EN PLUS des membres
 *                                       courants — typiquement l'exclu, qui
 *                                       n'est déjà plus dans conv_participants
 *                                       au moment de l'émission.
 * @returns {Promise<object|null>} le message inséré, ou null si l'écriture a
 *                                 échoué (l'appelant continue quand même).
 */
async function postSystemMessage({
  conversationID,
  actorID,
  event,
  payload = {},
  io = null,
  notifyExtra = [],
}) {
  if (!SYSTEM_MESSAGES_ENABLED) return null;
  try {
    const actorName = await loadUserName(actorID);

    const content = JSON.stringify({
      e: event,
      by: Number(actorID),
      byName: actorName,
      ...payload,
    });

    // `clientID` NULL est déjà admis, et l'index unique (senderID, clientID)
    // de MySQL tolère plusieurs NULL : aucun conflit d'idempotence à gérer.
    // `status = 1` (envoyé) : il n'y a pas d'accusé à collecter.
    const [result] = await pool.execute(
      `INSERT INTO message
         (senderID, conversationID, clientID, content, type, status, sendAt)
       VALUES (?, ?, NULL, ?, ?, 1, NOW())`,
      [actorID, conversationID, content, SYSTEM_MESSAGE_TYPE],
    );
    const msgID = result.insertId;

    // L'aperçu remonte la conversation dans la liste, MAIS aucun
    // `UPDATE conv_participants SET unreadCount` : voir le point 3 de l'en-tête.
    await pool.execute(
      `UPDATE conversation
          SET lastMessage = ?, lastMessageAt = NOW(),
              lastMessageSenderID = ?, lastMessageType = ?, lastMessageStatus = 1
        WHERE conversID = ?`,
      [
        systemPreviewFromContent(content),
        actorID,
        SYSTEM_MESSAGE_TYPE,
        conversationID,
      ],
    );

    const [rows] = await pool.execute(`${MSG_SELECT} WHERE m.msgID = ?`, [msgID]);
    const msg = rows[0] || null;
    if (!msg) return null;

    if (io) {
      // Room `user_<id>` et non `conversation_<id>` : cette dernière n'est
      // rejointe qu'à l'ouverture de l'écran de discussion, un membre posé sur
      // la liste des chats manquerait l'événement.
      const [members] = await pool.execute(
        'SELECT alanyaID FROM conv_participants WHERE conversID = ?',
        [conversationID],
      );
      const targets = new Set(members.map((r) => Number(r.alanyaID)));
      for (const extra of notifyExtra) {
        const id = parseInt(extra, 10);
        if (Number.isInteger(id) && id > 0) targets.add(id);
      }
      for (const id of targets) {
        io.to(`user_${id}`).emit('message:received', msg);
      }
    }

    return msg;
  } catch (error) {
    console.error('[SystemMessage] échec:', error.message);
    return null;
  }
}

async function loadUserName(alanyaID) {
  try {
    const [rows] = await pool.execute(
      'SELECT nom, pseudo FROM users WHERE alanyaID = ?',
      [alanyaID],
    );
    const row = rows[0];
    if (!row) return '';
    const nom = (row.nom || '').trim();
    return nom !== '' ? nom : (row.pseudo || '').trim();
  } catch (_) {
    return '';
  }
}

/**
 * Noms des utilisateurs visés, dans l'ordre des ids fournis.
 *
 * À appeler **AVANT** un DELETE : après, la ligne `conv_participants` a disparu
 * et c'est précisément pour ça qu'on dénormalise (point 2 de l'en-tête). La
 * table `users` survit, elle, mais l'appel avant suppression garde le code
 * symétrique pour tous les événements.
 */
async function loadUserNames(ids) {
  const clean = [
    ...new Set(
      (Array.isArray(ids) ? ids : [])
        .map((i) => parseInt(i, 10))
        .filter((i) => Number.isInteger(i) && i > 0),
    ),
  ];
  if (clean.length === 0) return { ids: [], names: [] };

  const placeholders = clean.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT alanyaID, nom, pseudo FROM users WHERE alanyaID IN (${placeholders})`,
    clean,
  );
  const byId = new Map(
    rows.map((r) => {
      const nom = (r.nom || '').trim();
      return [Number(r.alanyaID), nom !== '' ? nom : (r.pseudo || '').trim()];
    }),
  );

  // On conserve l'ordre demandé, et on écarte les ids introuvables plutôt que
  // de laisser un nom vide dans `names` : le client réplique la position des
  // noms sur celle des ids.
  const keptIds = clean.filter((id) => byId.has(id));
  return {
    ids: keptIds,
    names: keptIds.map((id) => byId.get(id)),
  };
}

module.exports = { postSystemMessage, loadUserNames, SYSTEM_MESSAGE_TYPE };
