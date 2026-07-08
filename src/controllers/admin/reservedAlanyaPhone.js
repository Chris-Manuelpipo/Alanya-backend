const pool = require('../../config/db');
const {
  normalize,
  validate,
  validateReservedCandidate,
  isPatternReserved,
} = require('../../utils/alanyaPhone');
const {
  phoneExists,
  isInReservedTable,
} = require('../../services/alanyaPhoneService');

const _mapRow = (row) => ({
  id: row.id,
  phone_canonical: row.phone_canonical,
  label: row.label,
  created_by: row.created_by,
  created_at: row.created_at,
  created_by_nom: row.created_by_nom,
  used_by_alanya_id: row.used_by_alanya_id,
  used_by_nom: row.used_by_nom,
  used_by_pseudo: row.used_by_pseudo,
  is_used: Boolean(row.is_used),
});

const _buildFilters = (q, available) => {
  const where = [];
  const params = [];

  const searchDigits = normalize(q);
  if (searchDigits) {
    where.push('r.phone_canonical LIKE ?');
    params.push(`${searchDigits}%`);
  } else if (String(q).trim()) {
    where.push('r.label LIKE ?');
    params.push(`%${String(q).trim()}%`);
  }

  if (available === '1' || available === 'true') {
    where.push(
      'NOT EXISTS (SELECT 1 FROM users u WHERE u.alanyaPhone = r.phone_canonical)'
    );
  } else if (available === '0' || available === 'false') {
    where.push(
      'EXISTS (SELECT 1 FROM users u WHERE u.alanyaPhone = r.phone_canonical)'
    );
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return { whereSql, params };
};

const _buildPatternSuggestion = async (searchDigits, tableRows) => {
  if (!searchDigits) return null;
  const v = validate(searchDigits);
  if (!v.ok || !isPatternReserved(searchDigits)) return null;
  if (tableRows.some((row) => row.phone_canonical === searchDigits)) return null;

  const taken = await phoneExists(searchDigits);
  return {
    id: null,
    phone_canonical: searchDigits,
    label: 'Pattern réservé (attribution directe)',
    source: 'pattern',
    is_used: taken,
    assignable: !taken,
  };
};

const checkAssignablePhone = async (req, res) => {
  try {
    const canonical = normalize(req.query.phone || '');
    const v = validate(canonical);
    if (!v.ok) {
      return res.status(400).json({ error: v.error });
    }

    const taken = await phoneExists(canonical);
    const inTable = await isInReservedTable(canonical);
    const pattern = isPatternReserved(canonical);

    let source = 'standard';
    if (pattern) source = 'pattern';
    else if (inTable) source = 'table';

    let hint = null;
    if (taken) {
      hint = null;
    } else if (pattern) {
      hint = 'Pattern réservé — attribution directe autorisée';
    } else if (v.tier === 8) {
      hint = 'Numéro standard (hors patterns réservés)';
    }

    res.json({
      phone_canonical: canonical,
      tier: v.tier,
      is_pattern_reserved: pattern,
      in_reserved_table: inTable,
      is_taken: taken,
      assignable: !taken,
      reason: taken ? 'Ce numéro est déjà utilisé' : null,
      source,
      hint,
    });
  } catch (error) {
    console.error('[Admin] checkAssignablePhone error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

const listReservedPhones = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      q = '',
      available = '',
    } = req.query;

    const pageN = Math.max(1, parseInt(page, 10) || 1);
    const limitN = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageN - 1) * limitN;

    const { whereSql, params } = _buildFilters(q, available);

    const [rows] = await pool.execute(
      `SELECT r.id, r.phone_canonical, r.label, r.created_by, r.created_at,
              u_creator.nom AS created_by_nom,
              u_owner.alanyaID AS used_by_alanya_id,
              u_owner.nom AS used_by_nom,
              u_owner.pseudo AS used_by_pseudo,
              (u_owner.alanyaID IS NOT NULL) AS is_used
       FROM reserved_alanya_phone r
       LEFT JOIN users u_creator ON r.created_by = u_creator.alanyaID
       LEFT JOIN users u_owner ON u_owner.alanyaPhone = r.phone_canonical
       ${whereSql}
       ORDER BY r.phone_canonical ASC
       LIMIT ${limitN} OFFSET ${offset}`,
      params
    );

    const [[countRow]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM reserved_alanya_phone r ${whereSql}`,
      params
    );

    const searchDigits = normalize(q);
    const patternSuggestion = await _buildPatternSuggestion(searchDigits, rows);

    res.json({
      items: rows.map(_mapRow),
      total: Number(countRow.total),
      page: pageN,
      limit: limitN,
      pattern_suggestion: patternSuggestion,
    });
  } catch (error) {
    console.error('[Admin] listReservedPhones error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

const addReservedPhone = async (req, res) => {
  try {
    const { phone, label } = req.body || {};
    const canonical = normalize(phone);
    const v = validateReservedCandidate(canonical);
    if (!v.ok) {
      return res.status(400).json({ error: v.error });
    }
    if (!label || !String(label).trim()) {
      return res.status(400).json({ error: 'label requis' });
    }
    if (await phoneExists(canonical)) {
      return res.status(409).json({ error: 'Ce numéro est déjà assigné à un utilisateur' });
    }

    await pool.execute(
      `INSERT INTO reserved_alanya_phone (phone_canonical, label, created_by)
       VALUES (?, ?, ?)`,
      [canonical, String(label).trim(), req.user.alanyaID]
    );

    res.status(201).json({ message: 'Numéro réservé ajouté', phone_canonical: canonical });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Ce numéro est déjà dans la liste réservée' });
    }
    console.error('[Admin] addReservedPhone error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

const removeReservedPhone = async (req, res) => {
  try {
    const canonical = normalize(req.params.phone);
    const [result] = await pool.execute(
      'DELETE FROM reserved_alanya_phone WHERE phone_canonical = ?',
      [canonical]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Numéro réservé introuvable' });
    }
    res.json({ message: 'Numéro retiré de la liste réservée' });
  } catch (error) {
    console.error('[Admin] removeReservedPhone error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = {
  listReservedPhones,
  checkAssignablePhone,
  addReservedPhone,
  removeReservedPhone,
};
