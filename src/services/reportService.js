const pool = require('../config/db');

/**
 * Signalements d'abus.
 *
 * Le dépôt est volontairement tolérant : signaler doit aboutir même quand la
 * personne s'y prend deux fois, même quand le message a disparu entre-temps.
 * Un refus technique, ici, se lit comme « on ne veut pas de votre plainte ».
 */

/** Motifs acceptés. Le libellé est côté client, la clé seule circule. */
const REPORT_REASONS = [
  'spam',
  'harassment',
  'hate',
  'violence',
  'sexual',
  'scam',
  'impersonation',
  'other',
];

const NOTE_MAX = 500;

/**
 * Ramène la cible à la forme de la table, ou lève.
 *
 * C'est ici qu'est tenu « exactement une cible renseignée » : la migration 073
 * ne peut pas l'exprimer en CHECK (MySQL refuse un CHECK sur une colonne
 * porteuse d'une action référentielle — erreur 3823), et les clés étrangères
 * ont été jugées plus précieuses que la contrainte. Ce chemin doit donc rester
 * le seul par lequel une ligne entre dans `report`.
 *
 * @param {{targetType?: string, targetId?: number|string}} raw
 * @returns {{targetType: 'message'|'user', msgId: number|null, userId: number|null}}
 */
function normalizeTarget(raw) {
  const targetType = String(raw?.targetType || '').trim();
  if (targetType !== 'message' && targetType !== 'user') {
    const err = new Error('Cible de signalement invalide');
    err.status = 400;
    throw err;
  }

  const id = Number(raw?.targetId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('Identifiant de cible invalide');
    err.status = 400;
    throw err;
  }

  return targetType === 'message'
    ? { targetType, msgId: id, userId: null }
    : { targetType, msgId: null, userId: id };
}

function normalizeReason(raw) {
  const reason = String(raw || '').trim().toLowerCase();
  if (!REPORT_REASONS.includes(reason)) {
    const err = new Error('Motif de signalement inconnu');
    err.status = 400;
    throw err;
  }
  return reason;
}

function normalizeNote(raw) {
  const note = raw == null ? '' : String(raw).trim();
  if (!note) return null;
  // Tronquer plutôt que refuser : la colonne est bornée à 500, et personne ne
  // doit perdre sa plainte parce qu'il l'a trouvée trop longue à écrire.
  return note.slice(0, NOTE_MAX);
}

// Extrait du message signalé. Généreux : un message long passe en entier.
// Tronquer plutôt que refuser, même raison que la note — personne ne doit
// perdre son signalement parce que le message visé était bavard.
const EXCERPT_MAX = 2000;

// Messages de contexte joints. Cinq suffisent à lever l'ambiguïté d'un
// « d'accord, je le fais » ; au-delà, c'est le fil entier qui remonterait vers
// le serveur, et un signalement ne doit pas devenir une porte de lecture.
const CONTEXT_MAX = 5;
const CONTEXT_TEXT_MAX = 500;

/**
 * Normalise l'extrait en clair fourni par la personne qui signale.
 *
 * Elle a le message sous les yeux — c'est pour ça qu'elle signale — et le
 * serveur, lui, ne peut pas l'ouvrir. En signalant, elle choisit de montrer
 * ce passage à la modération, et rien d'autre.
 *
 * Rend `null` quand rien n'est fourni : un client ancien ne joint pas
 * d'extrait, et son signalement doit rester recevable. C'est
 * `targetWasEncrypted` qui dit à la console s'il faut aller lire
 * `message.content` ou constater qu'il n'y a rien à lire.
 */
function normalizeExcerpt(raw) {
  const texte = raw == null ? '' : String(raw).trim();
  if (!texte) return null;
  return texte.slice(0, EXCERPT_MAX);
}

/**
 * Normalise les messages de contexte : `[{ senderID, sendAt, text }]`.
 *
 * Borné en nombre ET en longueur. Sans ces deux bornes, le champ serait un
 * moyen de faire remonter un fil entier en clair vers le serveur sous couvert
 * de signalement — l'inverse exact de ce que le chiffrement garantit.
 *
 * Les entrées mal formées sont écartées une par une : un contexte partiel
 * reste utile, alors qu'un signalement refusé pour une virgule ne l'est pas.
 */
function normalizeContext(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const sortie = [];
  for (const item of raw.slice(-CONTEXT_MAX)) {
    if (!item || typeof item !== 'object') continue;
    const texte = item.text == null ? '' : String(item.text).trim();
    if (!texte) continue;
    const senderID = Number(item.senderID);
    sortie.push({
      senderID: Number.isInteger(senderID) && senderID > 0 ? senderID : null,
      sendAt: item.sendAt == null ? null : String(item.sendAt).slice(0, 40),
      text: texte.slice(0, CONTEXT_TEXT_MAX),
    });
  }
  return sortie.length > 0 ? sortie : null;
}

/**
 * Enregistre un signalement.
 *
 * @returns {Promise<{id: number|null, duplicate: boolean}>} `duplicate` quand
 *   cet auteur avait déjà signalé cette cible — l'appel reste un succès côté
 *   client, qui n'a pas à distinguer les deux cas.
 */
async function createReport(reporterId, payload) {
  const { targetType, msgId, userId } = normalizeTarget(payload);
  const reason = normalizeReason(payload?.reason);
  const note = normalizeNote(payload?.note);
  const excerpt = normalizeExcerpt(payload?.targetExcerpt);
  const context = normalizeContext(payload?.contextExcerpt);

  if (targetType === 'user' && userId === reporterId) {
    const err = new Error('Impossible de se signaler soi-même');
    err.status = 400;
    throw err;
  }

  // Signaler son propre message n'a pas de sens non plus, et sert surtout à
  // polluer la file. La vérification tient dans la même requête que celle qui
  // valide l'existence du message.
  let targetWasEncrypted = 0;
  if (targetType === 'message') {
    const [[msg]] = await pool.execute(
      'SELECT senderID, enc_version FROM message WHERE msgID = ?',
      [msgId],
    );
    if (!msg) {
      const err = new Error('Message introuvable');
      err.status = 404;
      throw err;
    }
    if (msg.senderID === reporterId) {
      const err = new Error('Impossible de signaler son propre message');
      err.status = 400;
      throw err;
    }
    // Lu sur la LIGNE et non déclaré par le client : c'est cette colonne qui
    // dit à la console si l'absence d'extrait signifie « client trop ancien,
    // va lire message.content » ou « rien à lire, le corps est scellé ».
    targetWasEncrypted = Number(msg.enc_version) === 1 ? 1 : 0;
  }

  try {
    const [res] = await pool.execute(
      `INSERT INTO report (reporter_id, target_type, target_msg_id, target_user_id,
                           reason, note, target_excerpt, context_excerpt,
                           target_was_encrypted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reporterId, targetType, msgId, userId, reason, note,
        excerpt,
        context ? JSON.stringify(context) : null,
        targetWasEncrypted,
      ],
    );
    return { id: res.insertId, duplicate: false };
  } catch (e) {
    // Doublon : l'unique (reporter_id, cible) a mordu. Ce n'est pas une erreur
    // pour l'utilisateur — sa plainte est déjà enregistrée.
    if (e.code === 'ER_DUP_ENTRY') return { id: null, duplicate: true };
    throw e;
  }
}

module.exports = {
  REPORT_REASONS,
  NOTE_MAX,
  EXCERPT_MAX,
  CONTEXT_MAX,
  CONTEXT_TEXT_MAX,
  normalizeTarget,
  normalizeReason,
  normalizeNote,
  normalizeExcerpt,
  normalizeContext,
  createReport,
};
