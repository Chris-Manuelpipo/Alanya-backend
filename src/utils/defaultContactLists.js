const pool = require('../config/db');

/// Listes système — identifiées par `kind`, libellé affiché côté client (l10n).
const DEFAULT_CONTACT_LISTS = [
  { kind: 'family',  name: 'Famille',   color: '#C2185B', memberLimit: null },
  { kind: 'friends', name: 'Amis',      color: '#00796B', memberLimit: null },
  { kind: 'work',    name: 'Bureau',    color: '#3949AB', memberLimit: null },
  { kind: 'trust',   name: 'Confiance', color: '#B7791F', memberLimit: 5 },
];

const KIND_ORDER_SQL = `CASE cl.kind
  WHEN 'family'  THEN 1
  WHEN 'friends' THEN 2
  WHEN 'work'    THEN 3
  WHEN 'trust'   THEN 4
  ELSE 100
END`;

/**
 * Insère les listes système manquantes (idempotent par kind).
 * Rattrape member_limit / couleur sur les listes trust existantes.
 */
const ensureDefaultContactLists = async (alanyaID, executor = pool) => {
  for (const def of DEFAULT_CONTACT_LISTS) {
    const [rows] = await executor.execute(
      'SELECT idList, color, member_limit FROM contact_list WHERE alanyaID = ? AND kind = ?',
      [alanyaID, def.kind],
    );
    if (rows.length === 0) {
      // Rattrapage : liste créée avant l'intro de `kind` (match sur le nom FR).
      const [legacy] = await executor.execute(
        'SELECT idList, color, member_limit FROM contact_list WHERE alanyaID = ? AND kind IS NULL AND name = ?',
        [alanyaID, def.name],
      );
      if (legacy.length > 0) {
        await executor.execute(
          'UPDATE contact_list SET kind = ? WHERE idList = ?',
          [def.kind, legacy[0].idList],
        );
        const row = legacy[0];
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
        continue;
      }
      await executor.execute(
        'INSERT INTO contact_list (alanyaID, name, kind, color, member_limit) VALUES (?, ?, ?, ?, ?)',
        [alanyaID, def.name, def.kind, def.color, def.memberLimit],
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

const isSystemListKind = (kind) =>
  kind != null && DEFAULT_CONTACT_LISTS.some((d) => d.kind === kind);

module.exports = {
  DEFAULT_CONTACT_LISTS,
  KIND_ORDER_SQL,
  ensureDefaultContactLists,
  isSystemListKind,
};
