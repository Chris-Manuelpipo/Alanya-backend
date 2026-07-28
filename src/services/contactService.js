// Ajout d'un contact préféré — logique métier partagée par la route REST
// POST /api/contacts/:id et par la résolution d'un QR d'identité
// (POST /api/qr/resolve). Les deux appelants ont des sémantiques HTTP
// différentes (409 dur d'un côté, succès doux de l'autre) : le service renvoie
// donc un résultat discriminé et ne connaît aucun code de statut.

const pool = require('../config/db');

const _INVALID_URL_VALUES = ['NON DEFINI', 'INDEFINI', 'undefined', 'null', ''];

// Exportée plutôt que dupliquée : la colonne users.avatar_url porte des
// sentinelles historiques ('NON DEFINI', 'null'…) que tout lecteur doit filtrer
// de la même façon, sous peine d'incohérences d'affichage entre écrans.
const sanitizeUrl = (url) => {
  if (!url) return null;
  const trimmed = url.trim();
  if (_INVALID_URL_VALUES.includes(trimmed)) return null;
  if (!trimmed.startsWith('http')) return null;
  return trimmed;
};

const _contactBody = (idPrefContact, user) => ({
  idPrefContact,
  alanyaID:    user.alanyaID,
  nom:         user.nom,
  pseudo:      user.pseudo,
  alanyaPhone: user.alanyaPhone,
  avatar_url:  sanitizeUrl(user.avatar_url),
  is_online:   user.is_online,
});

/**
 * Ajoute `friendID` aux contacts préférés de `alanyaID`.
 * @returns {Promise<{ok: boolean, reason: string, contact?: object}>}
 *   reason ∈ 'added' | 'self' | 'not_found' | 'blocked' | 'already'
 */
const addContactByFriendId = async (alanyaID, friendID) => {
  if (friendID === alanyaID) {
    return { ok: false, reason: 'self' };
  }

  // Vérifier que l'ami existe
  const [userCheck] = await pool.execute(
    'SELECT alanyaID, nom, pseudo, alanyaPhone, avatar_url, is_online FROM users WHERE alanyaID = ? AND exclus = 0',
    [friendID]
  );
  if (userCheck.length === 0) {
    return { ok: false, reason: 'not_found' };
  }

  // Vérifier que l'utilisateur n'est pas bloqué (dans un sens ou dans l'autre)
  const [blockCheck] = await pool.execute(
    'SELECT idBlock FROM blocked WHERE (alanyaID = ? AND idCallerBlock = ?) OR (alanyaID = ? AND idCallerBlock = ?)',
    [alanyaID, friendID, friendID, alanyaID]
  );
  if (blockCheck.length > 0) {
    return { ok: false, reason: 'blocked' };
  }

  // Vérifier si déjà contact préféré
  const [existing] = await pool.execute(
    'SELECT idPrefContact FROM preferredContact WHERE alanyaID = ? AND idFriend = ?',
    [alanyaID, friendID]
  );
  if (existing.length > 0) {
    return {
      ok: false,
      reason: 'already',
      contact: _contactBody(existing[0].idPrefContact, userCheck[0]),
    };
  }

  const [result] = await pool.execute(
    'INSERT INTO preferredContact (alanyaID, idFriend, created_at) VALUES (?, ?, NOW())',
    [alanyaID, friendID]
  );

  return {
    ok: true,
    reason: 'added',
    contact: _contactBody(result.insertId, userCheck[0]),
  };
};

module.exports = { sanitizeUrl, addContactByFriendId };
