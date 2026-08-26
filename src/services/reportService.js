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

  if (targetType === 'user' && userId === reporterId) {
    const err = new Error('Impossible de se signaler soi-même');
    err.status = 400;
    throw err;
  }

  // Signaler son propre message n'a pas de sens non plus, et sert surtout à
  // polluer la file. La vérification tient dans la même requête que celle qui
  // valide l'existence du message.
  if (targetType === 'message') {
    const [[msg]] = await pool.execute(
      'SELECT senderID FROM message WHERE msgID = ?',
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
  }

  try {
    const [res] = await pool.execute(
      `INSERT INTO report (reporter_id, target_type, target_msg_id, target_user_id, reason, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [reporterId, targetType, msgId, userId, reason, note],
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
  normalizeTarget,
  normalizeReason,
  normalizeNote,
  createReport,
};
