const pool = require('../config/db');
const { maskPresenceIfBlocked } = require('../utils/blockUtils');
const { sanitizeUrl } = require('../services/contactService');
const { ensureDefaultContactLists, KIND_ORDER_SQL, isSystemListKind } = require('../utils/defaultContactLists');

// Listes de contacts (Famille / Amis / Bureau…) — CRUD des listes et de leurs
// membres. Tout est scopé au propriétaire (`req.user.alanyaID`) : une liste
// n'est jamais partagée, elle organise MES contacts préférés.

const NAME_MAX = 60;

// Nom de liste : obligatoire, coupé à 60 (longueur de la colonne).
const cleanName = (raw) => String(raw ?? '').trim().slice(0, NAME_MAX);

// Couleur de puce : #RGB, #RRGGBB ou #RRGGBBAA. Toute autre valeur (ou vide)
// vaut « pas de couleur » — la puce reprend alors la teinte du thème.
const cleanColor = (raw) => {
  if (raw == null) return null;
  const v = String(raw).trim();
  if (v === '') return null;
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v) ? v : null;
};

const parseListId = (raw) => {
  const id = parseInt(raw, 10);
  return Number.isNaN(id) || id <= 0 ? null : id;
};

// Vérifie que la liste existe ET m'appartient. Retourne la ligne ou null —
// on ne distingue pas « inexistante » de « celle d'un autre » (404 des deux
// côtés) pour ne pas révéler l'existence des listes d'autrui.
const findOwnedList = async (idList, alanyaID) => {
  const [rows] = await pool.execute(
    'SELECT idList, alanyaID, name, kind, color, member_limit, created_at FROM contact_list WHERE idList = ? AND alanyaID = ?',
    [idList, alanyaID]
  );
  return rows[0] || null;
};

const listRow = (r, memberCount = 0) => ({
  idList:      Number(r.idList),
  name:        r.name,
  kind:        r.kind ?? null,
  color:       r.color,
  memberLimit: r.member_limit != null ? Number(r.member_limit) : null,
  memberCount: Number(memberCount) || 0,
  createdAt:   r.created_at,
});

// Toutes mes listes, avec le nombre de membres de chacune.
const getLists = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    await ensureDefaultContactLists(alanyaID);

    const [rows] = await pool.execute(
      `SELECT
         cl.idList,
         cl.name,
         cl.kind,
         cl.color,
         cl.member_limit,
         cl.created_at,
         COUNT(clm.idFriend) AS member_count
       FROM contact_list cl
       LEFT JOIN contact_list_member clm ON clm.idList = cl.idList
       WHERE cl.alanyaID = ?
       GROUP BY cl.idList, cl.name, cl.kind, cl.color, cl.member_limit, cl.created_at
       ORDER BY ${KIND_ORDER_SQL}, cl.name ASC`,
      [alanyaID]
    );

    res.json(rows.map((r) => listRow(r, r.member_count)));
  } catch (error) {
    console.error('[getLists] ERROR:', error);
    res.status(500).json({ error: error.message });
  }
};

// Création d'une liste — nom unique par propriétaire (uq_list_name).
const createList = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const name = cleanName(req.body?.name);
    const color = cleanColor(req.body?.color);

    if (!name) {
      return res.status(400).json({ error: 'List name is required' });
    }

    let result;
    try {
      [result] = await pool.execute(
        'INSERT INTO contact_list (alanyaID, name, color) VALUES (?, ?, ?)',
        [alanyaID, name, color]
      );
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'A list with this name already exists' });
      }
      throw e;
    }

    res.status(201).json({
      idList:      Number(result.insertId),
      name,
      kind:        null,
      color,
      memberCount: 0,
    });
  } catch (error) {
    console.error('[createList] ERROR:', error);
    res.status(500).json({ error: error.message });
  }
};

// Renommer / recolorer. Les deux champs sont optionnels : `color: null` (ou
// chaîne vide) efface la couleur, `color` absent la laisse telle quelle.
const updateList = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const idList = parseListId(req.params.idList);
    if (!idList) {
      return res.status(400).json({ error: 'Invalid list ID' });
    }

    const existing = await findOwnedList(idList, alanyaID);
    if (!existing) {
      return res.status(404).json({ error: 'List not found' });
    }

    const hasName  = Object.prototype.hasOwnProperty.call(req.body || {}, 'name');
    const hasColor = Object.prototype.hasOwnProperty.call(req.body || {}, 'color');

    if (isSystemListKind(existing.kind) && hasName) {
      const requested = cleanName(req.body.name);
      if (requested !== existing.name) {
        return res.status(403).json({
          error: 'System list name cannot be changed',
          code: 'SYSTEM_LIST_READONLY',
        });
      }
    }

    const name  = hasName ? cleanName(req.body.name) : existing.name;
    const color = hasColor ? cleanColor(req.body.color) : existing.color;

    if (!name) {
      return res.status(400).json({ error: 'List name is required' });
    }

    try {
      await pool.execute(
        'UPDATE contact_list SET name = ?, color = ? WHERE idList = ? AND alanyaID = ?',
        [name, color, idList, alanyaID]
      );
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'A list with this name already exists' });
      }
      throw e;
    }

    const [[counted]] = await pool.execute(
      'SELECT COUNT(*) AS member_count FROM contact_list_member WHERE idList = ?',
      [idList]
    );

    res.json(listRow({ ...existing, name, color }, counted.member_count));
  } catch (error) {
    console.error('[updateList] ERROR:', error);
    res.status(500).json({ error: error.message });
  }
};

// Suppression — le ON DELETE CASCADE emporte les membres. Aucun contact
// préféré n'est touché : une liste n'est qu'un regroupement.
const deleteList = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const idList = parseListId(req.params.idList);
    if (!idList) {
      return res.status(400).json({ error: 'Invalid list ID' });
    }

    // Les listes système ne se suppriment pas. `updateList` protégeait déjà leur
    // nom, mais pas leur existence : la suppression réussissait, et
    // `ensureDefaultContactLists` recréait la liste VIDE au prochain GET — les
    // membres partaient avec elle (CASCADE sur fk_clm_list). Sans gravité pour
    // un rangement ; inacceptable pour « Confiance », qui est désormais
    // l'audience des trajets. Un cercle de sécurité ne doit pas pouvoir se vider
    // par un appui malheureux.
    const existing = await findOwnedList(idList, alanyaID);
    if (!existing) {
      return res.status(404).json({ error: 'List not found' });
    }
    if (isSystemListKind(existing.kind)) {
      return res.status(403).json({
        error: 'System list cannot be deleted',
        code: 'SYSTEM_LIST_READONLY',
      });
    }

    const [result] = await pool.execute(
      'DELETE FROM contact_list WHERE idList = ? AND alanyaID = ?',
      [idList, alanyaID]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'List not found' });
    }

    res.json({ message: 'List deleted' });
  } catch (error) {
    console.error('[deleteList] ERROR:', error);
    res.status(500).json({ error: error.message });
  }
};

// Membres d'une liste — même projection que getPreferredContacts pour que le
// client puisse les hydrater avec le même modèle User.
const getListMembers = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const idList = parseListId(req.params.idList);
    if (!idList) {
      return res.status(400).json({ error: 'Invalid list ID' });
    }

    const owned = await findOwnedList(idList, alanyaID);
    if (!owned) {
      return res.status(404).json({ error: 'List not found' });
    }

    const [rows] = await pool.execute(
      `SELECT
         clm.created_at,
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
       FROM contact_list_member clm
       JOIN users u ON clm.idFriend = u.alanyaID
       LEFT JOIN pays p ON u.idPays = p.idPays
       WHERE clm.idList = ?
         -- Exclusion des blocages, DANS LES DEUX SENS. On masquait jusqu'ici la
         -- présence (maskPresenceIfBlocked) sans retirer la ligne : la liste
         -- « Confiance » proposait donc de confier sa sécurité à quelqu'un qui
         -- vous a bloqué. Même filtre que loadTrustCircle (tripService.js).
         AND NOT EXISTS (
               SELECT 1 FROM blocked b
                WHERE (b.alanyaID = ?          AND b.idCallerBlock = u.alanyaID)
                   OR (b.alanyaID = u.alanyaID AND b.idCallerBlock = ?)
             )
       ORDER BY u.nom ASC`,
      [idList, alanyaID, alanyaID]
    );

    const members = [];
    for (const r of rows) {
      const masked = await maskPresenceIfBlocked(
        alanyaID, r.alanyaID, r.is_online, r.last_seen,
      );
      members.push({
        addedAt:      r.created_at,
        alanyaID:     r.alanyaID,
        nom:          r.nom,
        pseudo:       r.pseudo,
        alanyaPhone:  r.alanyaPhone,
        idPays:       r.idPays,
        pays_libelle: r.pays_libelle,
        pays_prefix:  r.pays_prefix,
        avatar_url:   sanitizeUrl(r.avatar_url),
        is_online:    masked.is_online,
        last_seen:    masked.last_seen,
      });
    }

    res.json(members);
  } catch (error) {
    console.error('[getListMembers] ERROR:', error);
    res.status(500).json({ error: error.message });
  }
};

// Ajout d'un membre — uniquement un contact DÉJÀ préféré du propriétaire :
// une liste range les favoris, elle n'en crée pas.
const addMember = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const idList = parseListId(req.params.idList);
    const friendID = parseInt(req.params.friendID, 10);

    if (!idList) {
      return res.status(400).json({ error: 'Invalid list ID' });
    }
    if (!friendID || Number.isNaN(friendID)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const owned = await findOwnedList(idList, alanyaID);
    if (!owned) {
      return res.status(404).json({ error: 'List not found' });
    }

    const [pref] = await pool.execute(
      'SELECT idPrefContact FROM preferredContact WHERE alanyaID = ? AND idFriend = ?',
      [alanyaID, friendID]
    );
    // 403 et non 400 : la requête est bien formée, c'est la règle métier
    // « un membre est d'abord un favori » qui l'interdit (cf. dossier de
    // conception §4.1 et recette §7.1).
    if (pref.length === 0) {
      return res.status(403).json({ error: 'User is not a preferred contact' });
    }

    if (owned.member_limit != null) {
      const [[counted]] = await pool.execute(
        'SELECT COUNT(*) AS member_count FROM contact_list_member WHERE idList = ?',
        [idList],
      );
      const current = Number(counted.member_count) || 0;
      const [already] = await pool.execute(
        'SELECT 1 FROM contact_list_member WHERE idList = ? AND idFriend = ?',
        [idList, friendID],
      );
      if (already.length === 0 && current >= owned.member_limit) {
        return res.status(409).json({
          error: 'List member limit reached',
          code: 'LIST_MEMBER_LIMIT',
          limit: owned.member_limit,
        });
      }
    }

    // INSERT IGNORE : ré-ajouter un membre déjà présent est idempotent (la PK
    // composite garantit l'unicité), pas une erreur à remonter à l'écran.
    await pool.execute(
      'INSERT IGNORE INTO contact_list_member (idList, idFriend) VALUES (?, ?)',
      [idList, friendID]
    );

    res.status(201).json({ idList, idFriend: friendID });
  } catch (error) {
    console.error('[addMember] ERROR:', error);
    res.status(500).json({ error: error.message });
  }
};

const removeMember = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const idList = parseListId(req.params.idList);
    const friendID = parseInt(req.params.friendID, 10);

    if (!idList) {
      return res.status(400).json({ error: 'Invalid list ID' });
    }
    if (!friendID || Number.isNaN(friendID)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const owned = await findOwnedList(idList, alanyaID);
    if (!owned) {
      return res.status(404).json({ error: 'List not found' });
    }

    const [result] = await pool.execute(
      'DELETE FROM contact_list_member WHERE idList = ? AND idFriend = ?',
      [idList, friendID]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    res.json({ message: 'Member removed' });
  } catch (error) {
    console.error('[removeMember] ERROR:', error);
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  getLists,
  createList,
  updateList,
  deleteList,
  getListMembers,
  addMember,
  removeMember,
};
