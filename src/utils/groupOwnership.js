const pool = require('../config/db');
const { postSystemMessage, loadUserNames } = require('./systemMessage');

/**
 * Invariant : **tout groupe vivant a exactement un propriétaire** (`role = 2`).
 *
 * La migration 024 l'établit, et rien dans l'application ne fonctionne sans
 * lui : `requireGroupOwner` est la seule porte vers la promotion et la
 * rétrogradation. Un groupe qui perd son propriétaire répond 403
 * `GROUP_OWNER_REQUIRED` pour toujours — définitivement ingérable.
 *
 * Or un membre peut sortir d'un groupe par QUATRE chemins, et trois d'entre
 * eux préexistaient à cet invariant, donc l'ignoraient :
 *
 *   POST   /conversations/:id/leave     → leaveGroup
 *   DELETE /conversations/:id           → deleteConversation
 *   POST   /conversations/batch-delete  → batchDeleteConversations
 *   suppression de compte               → ON DELETE CASCADE
 *
 * D'où ce module : la succession vit ici, appelée depuis tous ces chemins,
 * plutôt que dupliquée — ou oubliée.
 */

/**
 * Rétablit un propriétaire après le départ de [departingID], si ce départ a
 * laissé le groupe sans `role = 2`.
 *
 * **À appeler APRÈS la suppression de la ligne `conv_participants`** : la
 * fonction constate l'état réel plutôt que de le prédire, ce qui la rend
 * idempotente et utilisable même quand l'appelant ne sait pas si le partant
 * était propriétaire.
 *
 * Choix du successeur : l'admin restant le plus ancien, à défaut le membre le
 * plus ancien. `ORDER BY role DESC, joinedAt ASC, id ASC` — le `id` départage
 * deux `joinedAt` identiques, `joinedAt` étant à la seconde près.
 *
 * @returns {Promise<{alanyaID: number, name: string}|null>} le nouveau
 *          propriétaire, ou null s'il n'y avait rien à faire.
 */
async function ensureGroupOwner(conversID, { departingID = null, io = null, actorID = null } = {}) {
  try {
    const [convRows] = await pool.execute(
      'SELECT isGroup FROM conversation WHERE conversID = ?',
      [conversID],
    );
    // Conversation supprimée entre-temps (dernier membre parti), ou 1-1 : les
    // rôles n'y ont aucun sens.
    if (convRows.length === 0 || !convRows[0].isGroup) return null;

    const [members] = await pool.execute(
      `SELECT alanyaID, role
         FROM conv_participants
        WHERE conversID = ?
        ORDER BY role DESC, joinedAt ASC, id ASC`,
      [conversID],
    );
    if (members.length === 0) return null;

    // Un propriétaire est déjà en place : rien à faire. C'est ce test qui rend
    // l'appel sûr depuis n'importe quel chemin de sortie.
    if (members.some((m) => Number(m.role) === 2)) return null;

    const successor = members[0];
    await pool.execute(
      'UPDATE conv_participants SET role = 2 WHERE conversID = ? AND alanyaID = ?',
      [conversID, successor.alanyaID],
    );
    await pool.execute(
      'UPDATE conversation SET createdBy = ? WHERE conversID = ?',
      [successor.alanyaID, conversID],
    );

    const names = await loadUserNames([successor.alanyaID]);

    // Trace dans le fil : la propriété a changé de mains sans que personne ne
    // l'ait demandé, les membres doivent pouvoir le constater.
    await postSystemMessage({
      conversationID: Number(conversID),
      // L'acteur est le partant quand on le connaît (il est à l'origine du
      // changement), sinon le successeur lui-même — le message reste lisible
      // dans les deux cas.
      actorID: actorID ?? departingID ?? successor.alanyaID,
      event: 'role_changed',
      payload: { ids: names.ids, names: names.names, role: 2 },
      io,
    });

    return {
      alanyaID: Number(successor.alanyaID),
      name: names.names[0] ?? '',
    };
  } catch (error) {
    // Ne jamais faire échouer le départ pour ça : le membre est déjà sorti, et
    // un groupe sans propriétaire reste réparable au prochain passage.
    console.error('[GroupOwnership] ensureGroupOwner:', error.message);
    return null;
  }
}

module.exports = { ensureGroupOwner };
