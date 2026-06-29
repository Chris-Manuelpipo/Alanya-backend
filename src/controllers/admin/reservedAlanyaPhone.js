const pool = require('../../config/db');
const { normalize, validate } = require('../../utils/alanyaPhone');
const { phoneExists } = require('../../services/alanyaPhoneService');

const listReservedPhones = async (req, res) => {
  try {
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
       ORDER BY r.phone_canonical ASC`
    );
    res.json(rows);
  } catch (error) {
    console.error('[Admin] listReservedPhones error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

const addReservedPhone = async (req, res) => {
  try {
    const { phone, label } = req.body || {};
    const canonical = normalize(phone);
    const v = validate(canonical);
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
  addReservedPhone,
  removeReservedPhone,
};
