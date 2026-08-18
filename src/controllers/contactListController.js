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

// ── SONNERIES DE LISTE (synchronisées entre les appareils du compte) ──
// La sélection est une préférence DU COMPTE, pas de l'appareil. On ne stocke
// jamais le fichier audio d'une sonnerie importée : seulement son identité.
//   builtin → id stable d'un son fourni avec l'app (`notif_pop`, `bundled_son3`,
//             `__system_default__`) ; le fichier existe sur tous les appareils.
//   custom  → SHA-256 du CONTENU du fichier importé. Le nom (`*_name`) n'est
//             qu'un libellé d'affichage : deux fichiers homonymes de contenu
//             différent restent deux sons différents.
const VALID_SOUND_TYPES = new Set(['builtin', 'custom']);

const cleanSoundType = (raw) => {
  if (raw == null) return null;
  const v = String(raw).trim();
  return VALID_SOUND_TYPES.has(v) ? v : null;
};

// Identifiant de son : id fourni (`notif_pop`) ou hash hexadécimal. Tout ce qui
// sort de cet alphabet est refusé plutôt que tronqué — un identifiant abîmé ne
// résoudrait rien côté client et masquerait le vrai problème.
const cleanSoundId = (raw) => {
  if (raw == null) return null;
  const v = String(raw).trim();
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(v) ? v : null;
};

const cleanSoundName = (raw) => {
  if (raw == null) return null;
  const v = String(raw).trim().slice(0, 120);
  return v === '' ? null : v;
};

// Fusionne le patch reçu avec l'existant pour UN évènement (`message`/`call`).
// Champ absent = inchangé ; champ à null = effacé. Un triplet incohérent
// (type sans identifiant) est ramené à « pas de choix » plutôt qu'enregistré à
// moitié : le client retomberait de toute façon sur son son par défaut.
const mergeSoundPatch = (body, prefix, existing) => {
  const has = (key) => Object.prototype.hasOwnProperty.call(body || {}, key);
  const pick = (suffix, clean, current) => {
    const key = `${prefix}Sound${suffix}`;
    return has(key) ? clean(body[key]) : current;
  };

  const type = pick('Type', cleanSoundType, existing.type);
  const id = pick('Id', cleanSoundId, existing.id);
  let name = pick('Name', cleanSoundName, existing.name);

  if (!type || !id) return { type: null, id: null, name: null };
  // Le libellé d'un son fourni vient des traductions du client, pas d'ici.
  if (type === 'builtin') name = null;
  return { type, id, name };
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
    `SELECT idList, alanyaID, name, kind, color, member_limit,
            msg_sound_type, msg_sound_id, msg_sound_name,
            call_sound_type, call_sound_id, call_sound_name,
            sound_priority, created_at
       FROM contact_list WHERE idList = ? AND alanyaID = ?`,
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
  // Sonneries de la liste — voir migration 055. Toujours présentes dans la
  // réponse (à null quand la liste n'a jamais été configurée) : le client
  // distingue « pas de choix » de « choix = sonnerie système », qui vaut
  // builtin/__system_default__.
  messageSoundType: r.msg_sound_type ?? null,
  messageSoundId:   r.msg_sound_id ?? null,
  messageSoundName: r.msg_sound_name ?? null,
  callSoundType:    r.call_sound_type ?? null,
  callSoundId:      r.call_sound_id ?? null,
  callSoundName:    r.call_sound_name ?? null,
  soundPriority:    r.sound_priority != null ? Number(r.sound_priority) : null,
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
         cl.msg_sound_type,
         cl.msg_sound_id,
         cl.msg_sound_name,
         cl.call_sound_type,
         cl.call_sound_id,
         cl.call_sound_name,
         cl.sound_priority,
         cl.created_at,
         COUNT(clm.idFriend) AS member_count
       FROM contact_list cl
       LEFT JOIN contact_list_member clm ON clm.idList = cl.idList
       WHERE cl.alanyaID = ?
       GROUP BY cl.idList, cl.name, cl.kind, cl.color, cl.member_limit,
                cl.msg_sound_type, cl.msg_sound_id, cl.msg_sound_name,
                cl.call_sound_type, cl.call_sound_id, cl.call_sound_name,
                cl.sound_priority, cl.created_at
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

    res.status(201).json(
      listRow(
        { idList: result.insertId, name, kind: null, color, member_limit: null },
        0,
      ),
    );
  } catch (error) {
    console.error('[createList] ERROR:', error);
    res.status(500).json({ error: error.message });
  }
};

// Renommer / recolorer / choisir les sonneries de la liste. Tous les champs
// sont optionnels : `color: null` (ou chaîne vide) efface la couleur, `color`
// absent la laisse telle quelle — même règle pour les six champs de son.
//
// Les sonneries sont acceptées y compris sur une liste SYSTÈME (Famille,
// Confiance…) : c'est leur nom qui est verrouillé, pas leurs préférences.
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

    const msg = mergeSoundPatch(req.body, 'message', {
      type: existing.msg_sound_type,
      id:   existing.msg_sound_id,
      name: existing.msg_sound_name,
    });
    const call = mergeSoundPatch(req.body, 'call', {
      type: existing.call_sound_type,
      id:   existing.call_sound_id,
      name: existing.call_sound_name,
    });

    try {
      await pool.execute(
        `UPDATE contact_list
            SET name = ?, color = ?,
                msg_sound_type = ?, msg_sound_id = ?, msg_sound_name = ?,
                call_sound_type = ?, call_sound_id = ?, call_sound_name = ?
          WHERE idList = ? AND alanyaID = ?`,
        [
          name, color,
          msg.type, msg.id, msg.name,
          call.type, call.id, call.name,
          idList, alanyaID,
        ]
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

    res.json(listRow({
      ...existing,
      name,
      color,
      msg_sound_type:  msg.type,
      msg_sound_id:    msg.id,
      msg_sound_name:  msg.name,
      call_sound_type: call.type,
      call_sound_id:   call.id,
      call_sound_name: call.name,
    }, counted.member_count));
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

// Ordre de priorité des sonneries de liste. Un contact peut appartenir à
// plusieurs listes : c'est cet ordre qui désigne celle qui sonne. Il vit avec
// les sons plutôt qu'avec chaque appareil — sans lui, deux appareils pourtant
// d'accord sur les sons jouaient encore des sonneries différentes pour un
// contact multi-listes.
//
// Ré-écriture complète (et non un rang par liste) : l'écran envoie la file
// telle qu'il l'affiche, ce qui évite tout état intermédiaire où deux listes
// partageraient le même rang.
const updateSoundOrder = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const alanyaID = req.user.alanyaID;
    const raw = req.body?.order;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ error: 'order must be an array of list IDs' });
    }

    // Dédoublonnage en conservant la première occurrence : un id répété ne doit
    // pas décaler silencieusement le reste de la file.
    const ids = [];
    for (const item of raw) {
      const id = parseListId(item);
      if (id && !ids.includes(id)) ids.push(id);
    }

    await conn.beginTransaction();
    // Remise à zéro d'abord : une liste retirée de la file (ou supprimée) ne
    // doit pas garder son ancien rang.
    await conn.execute(
      'UPDATE contact_list SET sound_priority = NULL WHERE alanyaID = ?',
      [alanyaID],
    );
    for (let i = 0; i < ids.length; i += 1) {
      // Le WHERE sur alanyaID suffit à ignorer un id qui ne m'appartient pas.
      await conn.execute(
        'UPDATE contact_list SET sound_priority = ? WHERE idList = ? AND alanyaID = ?',
        [i, ids[i], alanyaID],
      );
    }
    await conn.commit();

    res.json({ order: ids });
  } catch (error) {
    try { await conn.rollback(); } catch (_) { /* connexion déjà perdue */ }
    console.error('[updateSoundOrder] ERROR:', error);
    res.status(500).json({ error: error.message });
  } finally {
    conn.release();
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
  updateSoundOrder,
  deleteList,
  getListMembers,
  addMember,
  removeMember,
};
