const pool = require('../config/db');

/// Listes créées automatiquement pour chaque compte (doc liste-contacts.pdf).
const DEFAULT_CONTACT_LISTS = [
  { name: 'Famille', color: '#C2185B', memberLimit: null },
  { name: 'Amis', color: '#00796B', memberLimit: null },
  { name: 'Bureau', color: '#3949AB', memberLimit: null },
  { name: 'Confiance', color: '#B7791F', memberLimit: 5 },
];

/**
 * Insère les listes par défaut manquantes (idempotent par nom).
 * Rattrape aussi member_limit / couleur sur Confiance si la liste existait déjà.
 */
const ensureDefaultContactLists = async (alanyaID, executor = pool) => {
  for (const def of DEFAULT_CONTACT_LISTS) {
    const [rows] = await executor.execute(
      'SELECT idList, color, member_limit FROM contact_list WHERE alanyaID = ? AND name = ?',
      [alanyaID, def.name],
    );
    if (rows.length === 0) {
      await executor.execute(
        'INSERT INTO contact_list (alanyaID, name, color, member_limit) VALUES (?, ?, ?, ?)',
        [alanyaID, def.name, def.color, def.memberLimit],
      );
      continue;
    }
    const row = rows[0];
    if (def.memberLimit != null && row.member_limit == null) {
      await executor.execute(
        'UPDATE contact_list SET member_limit = ? WHERE idList = ?',
        [def.memberLimit, row.idList],
      );
    }
    if (def.color && (!row.color || String(row.color).trim() === '')) {
      await executor.execute(
        'UPDATE contact_list SET color = ? WHERE idList = ?',
        [def.color, row.idList],
      );
    }
  }
};

module.exports = {
  DEFAULT_CONTACT_LISTS,
  ensureDefaultContactLists,
};
