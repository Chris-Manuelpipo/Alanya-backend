const pool = require('../config/db');
const { sanitizeUrl, addContactByFriendId } = require('../services/contactService');

// Contacts préférés : liste, ajout, suppression, vérification
const getPreferredContacts = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;

    // LIMIT en dur (pas un curseur), même raison que GET /conversations
    // (audit scalabilité 06/08/2026 §3.2/§3.3) : le client traite la réponse
    // comme la liste complète et démarque en local tout contact absent.
    const [rows] = await pool.execute(
      `SELECT
         pc.idPrefContact,
         pc.created_at,
         pc.added_via,
         pc.added_note,
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
       ORDER BY u.nom ASC
       LIMIT 1000`,
      [alanyaID]
    );

    // Masquage de présence en 1 requête batch au lieu d'un SELECT par contact
    // (N+1 signalé par l'audit scalabilité 06/08/2026 §3.2) : "qui, parmi mes
    // contacts, m'a bloqué ?" — même sémantique que maskPresenceIfBlocked
    // (blockUtils.js) mais résolue pour toute la liste d'un coup.
    let blockedMeSet = new Set();
    if (rows.length > 0) {
      const contactIds = rows.map((r) => r.alanyaID);
      const [blockedRows] = await pool.query(
        'SELECT alanyaID FROM blocked WHERE idCallerBlock = ? AND alanyaID IN (?)',
        [alanyaID, contactIds],
      );
      blockedMeSet = new Set(blockedRows.map((b) => Number(b.alanyaID)));
    }

    const contacts = rows.map((r) => {
      const blockedMe = Number(r.alanyaID) !== alanyaID && blockedMeSet.has(Number(r.alanyaID));
      return {
        idPrefContact: r.idPrefContact,
        addedAt:       r.created_at,
        addedVia:      r.added_via,
        addedNote:     r.added_note,
        alanyaID:      r.alanyaID,
        nom:           r.nom,
        pseudo:        r.pseudo,
        alanyaPhone:   r.alanyaPhone,
        idPays:        r.idPays,
        pays_libelle:  r.pays_libelle,
        pays_prefix:   r.pays_prefix,
        avatar_url:    sanitizeUrl(r.avatar_url),
        is_online:     blockedMe ? 0 : r.is_online,
        last_seen:     blockedMe ? null : r.last_seen,
      };
    });

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

// Note contextuelle d'un contact préféré — saisie juste après un scan pour se
// souvenir de la rencontre. Vide ou absente = effacement. Elle appartient à la
// RELATION (mon lien vers lui), jamais au profil de l'autre.
const setContactNote = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const friendID = parseInt(req.params.id, 10);
    if (!friendID || isNaN(friendID)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const brute = req.body?.note;
    const note = brute == null ? '' : String(brute).trim().slice(0, 200);

    const [result] = await pool.execute(
      'UPDATE preferredContact SET added_note = ? WHERE alanyaID = ? AND idFriend = ?',
      [note === '' ? null : note, alanyaID, friendID]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Not a preferred contact' });
    }

    res.json({ ok: true, addedNote: note === '' ? null : note });
  } catch (error) {
    console.error('[setContactNote] ERROR:', error);
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

    // Être un contact préféré est le PRÉREQUIS pour appartenir à une liste
    // (cf. addMember de contactListController). Le retirer des favoris doit
    // donc le sortir de toutes MES listes — sinon il y resterait en membre
    // fantôme, impossible à ré-ajouter et invisible dans les favoris.
    // Restreint à mes listes : les listes des autres ne me regardent pas.
    await pool.execute(
      `DELETE clm FROM contact_list_member clm
         JOIN contact_list cl ON cl.idList = clm.idList
        WHERE cl.alanyaID = ? AND clm.idFriend = ?`,
      [alanyaID, friendID]
    );

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
  setContactNote,
};