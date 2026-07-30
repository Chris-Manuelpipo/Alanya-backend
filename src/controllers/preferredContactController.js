const pool = require('../config/db');
const { maskPresenceIfBlocked } = require('../utils/blockUtils');
const { sanitizeUrl, addContactByFriendId } = require('../services/contactService');

// Contacts préférés : liste, ajout, suppression, vérification
const getPreferredContacts = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;

    const [rows] = await pool.execute(
      `SELECT
         pc.idPrefContact,
         pc.created_at,
         pc.added_via,
         u.alanyaID,
         u.nom,
         u.pseudo,
         u.alanyaPhone,
         u.idPays,
         u.avatar_url,
         u.is_online,
         u.last_seen,
         p.libelle AS pays_libelle,
         p.prefix AS pays_prefix
       FROM preferredContact pc
       JOIN users u ON pc.idFriend = u.alanyaID
       LEFT JOIN pays p ON u.idPays = p.idPays
       WHERE pc.alanyaID = ?
       ORDER BY u.nom ASC`,
      [alanyaID]
    );

    const contacts = [];
    for (const r of rows) {
      const masked = await maskPresenceIfBlocked(
        alanyaID, r.alanyaID, r.is_online, r.last_seen,
      );
      contacts.push({
        idPrefContact: r.idPrefContact,
        addedAt:       r.created_at,
        addedVia:      r.added_via,
        alanyaID:      r.alanyaID,
        nom:           r.nom,
        pseudo:        r.pseudo,
        alanyaPhone:   r.alanyaPhone,
        idPays:        r.idPays,
        pays_libelle:  r.pays_libelle,
        pays_prefix:   r.pays_prefix,
        avatar_url:    sanitizeUrl(r.avatar_url),
        is_online:     masked.is_online,
        last_seen:     masked.last_seen,
      });
    }

    res.json(contacts);
  } catch (error) {
    console.error('[getPreferredContacts] ERROR:', error);
    res.status(500).json({ error: error.message });
  }
};

// Ajout d'un contact préféré 
const addPreferredContact = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const friendID = parseInt(req.params.id, 10);

    if (!friendID || isNaN(friendID)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Liste blanche : 'qr' sert à l'ajout EN RETOUR après un scan (les deux
    // directions du lien portent alors la même origine). Toute autre valeur
    // retombe sur 'search' — cette métadonnée est cosmétique, pas de la
    // sécurité, mais on ne laisse pas le client inventer des origines.
    const addedVia = req.body?.addedVia === 'qr' ? 'qr' : 'search';

    const result = await addContactByFriendId(alanyaID, friendID, { addedVia });

    switch (result.reason) {
      case 'self':
        return res.status(400).json({ error: 'Cannot add yourself as contact' });
      case 'not_found':
        return res.status(404).json({ error: 'User not found' });
      case 'blocked':
        return res.status(403).json({ error: 'Cannot add blocked user' });
      case 'already':
        return res.status(409).json({ error: 'Already a preferred contact' });
      default:
        return res.status(201).json(result.contact);
    }
  } catch (error) {
    console.error('[addPreferredContact] ERROR:', error);
    res.status(500).json({ error: error.message });
  }
};

// Supprimer un contact préféré 
const removePreferredContact = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const friendID = parseInt(req.params.id, 10);

    if (!friendID || isNaN(friendID)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const [result] = await pool.execute(
      'DELETE FROM preferredContact WHERE alanyaID = ? AND idFriend = ?',
      [alanyaID, friendID]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    res.json({ message: 'Contact removed' });
  } catch (error) {
    console.error('[removePreferredContact] ERROR:', error);
    res.status(500).json({ error: error.message });
  }
};

// Vérifier si c'est un contact 
const checkIsContact = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const friendID = parseInt(req.params.id, 10);

    const [rows] = await pool.execute(
      'SELECT idPrefContact FROM preferredContact WHERE alanyaID = ? AND idFriend = ?',
      [alanyaID, friendID]
    );

    res.json({ isContact: rows.length > 0 });
  } catch (error) {
    console.error('[checkIsContact] ERROR:', error);
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  getPreferredContacts,
  addPreferredContact,
  removePreferredContact,
  checkIsContact,
};