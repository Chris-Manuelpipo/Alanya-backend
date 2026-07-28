const pool = require('../config/db');
const { generateOpaqueToken, identityPayload, secretMatches } = require('../utils/qrToken');
const { addContactByFriendId } = require('../services/contactService');
const qrLoginSessions = require('../socket/state/qrLoginSessions');

// Le QR n'encode jamais une donnée brute (alanyaID énumérable, alanyaPhone qui
// sert aussi à se connecter) : uniquement une URL portant un jeton opaque.
// La base d'URL est partagée avec qrAuthController via utils/qrToken.

const _QR_PATH_RE = /^\/q\/(u|l)\/([^/]+)$/;

/**
 * Le parsing du payload est la responsabilité du serveur : le client envoie la
 * chaîne brute qu'il vient de scanner, sans jamais l'interpréter. Le domaine
 * n'est pas vérifié — l'autorité de résolution est le jeton, pas l'hôte, et un
 * QR déjà imprimé sous un ancien domaine doit continuer à fonctionner.
 */
const _parsePayload = (raw) => {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;

  let pathname;
  try {
    pathname = new URL(value).pathname;
  } catch {
    return null;
  }

  const match = _QR_PATH_RE.exec(pathname);
  if (!match) return null;

  if (match[1] === 'u') {
    return { type: 'contact', qrPublicId: match[2] };
  }

  // Forme « <sessionId>.<scanSecret> » : les deux jetons sont en base64url,
  // donc le point ne peut appartenir ni à l'un ni à l'autre.
  const dot = match[2].indexOf('.');
  if (dot <= 0 || dot === match[2].length - 1) return null;
  return {
    type: 'login',
    sessionId:  match[2].slice(0, dot),
    scanSecret: match[2].slice(dot + 1),
  };
};


const _toIso = (value) => {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * Retourne le qr_public_id du compte, en le créant à la volée s'il est encore
 * NULL (comptes antérieurs à la migration 026).
 *
 * Deux requêtes concurrentes du même compte génèrent chacune leur jeton :
 * l'UPDATE conditionné par `qr_public_id IS NULL` fait perdre la seconde, qui
 * relit alors le jeton gagnant. L'ER_DUP_ENTRY, lui, ne peut venir que d'une
 * collision entre deux jetons aléatoires — on retente.
 */
const _ensureQrPublicId = async (alanyaID) => {
  const [rows] = await pool.execute(
    'SELECT qr_public_id FROM users WHERE alanyaID = ?',
    [alanyaID]
  );
  if (rows.length === 0) return null;
  if (rows[0].qr_public_id) return rows[0].qr_public_id;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await pool.execute(
        'UPDATE users SET qr_public_id = ? WHERE alanyaID = ? AND qr_public_id IS NULL',
        [generateOpaqueToken(), alanyaID]
      );
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY') throw error;
    }

    const [again] = await pool.execute(
      'SELECT qr_public_id FROM users WHERE alanyaID = ?',
      [alanyaID]
    );
    if (again[0]?.qr_public_id) return again[0].qr_public_id;
  }

  throw new Error('Impossible de générer un qr_public_id unique');
};

// Mon code QR d'identité (créé au premier appel)
const getMyQr = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;

    const qrPublicId = await _ensureQrPublicId(alanyaID);
    if (!qrPublicId) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    res.json({ qrPublicId, payload: identityPayload(qrPublicId) });
  } catch (error) {
    console.error('[getMyQr] ERROR:', error);
    res.status(500).json({ error: error.message });
  }
};

// Régénère le code : les QR déjà partagés cessent immédiatement de résoudre
const regenerateQr = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;

    for (let attempt = 0; attempt < 5; attempt++) {
      const qrPublicId = generateOpaqueToken();
      try {
        const [result] = await pool.execute(
          'UPDATE users SET qr_public_id = ? WHERE alanyaID = ?',
          [qrPublicId, alanyaID]
        );
        if (result.affectedRows === 0) {
          return res.status(404).json({ error: 'Utilisateur non trouvé' });
        }
        return res.json({ qrPublicId, payload: identityPayload(qrPublicId) });
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error;
      }
    }

    throw new Error('Impossible de générer un qr_public_id unique');
  } catch (error) {
    console.error('[regenerateQr] ERROR:', error);
    res.status(500).json({ error: error.message });
  }
};

const _resolveContact = async (req, res, alanyaID, qrPublicId) => {
  const [rows] = await pool.execute(
    'SELECT alanyaID FROM users WHERE qr_public_id = ? AND exclus = 0',
    [qrPublicId]
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: 'Code QR inconnu ou expiré' });
  }

  const result = await addContactByFriendId(alanyaID, rows[0].alanyaID);

  switch (result.reason) {
    case 'self':
      return res.json({ type: 'contact', self: true });
    case 'not_found':
      return res.status(404).json({ error: 'Code QR inconnu ou expiré' });
    case 'blocked':
      return res.status(403).json({ error: 'Impossible d\'ajouter cet utilisateur' });
    case 'already':
      // Rescanner un contact déjà enregistré n'est pas une erreur pour qui scanne.
      return res.json({
        type: 'contact', added: false, alreadyContact: true, contact: result.contact,
      });
    default:
      return res.json({
        type: 'contact', added: true, alreadyContact: false, contact: result.contact,
      });
  }
};

/**
 * Branche « connexion » : strictement en lecture seule côté autorisation. Elle
 * ne fait que constater le scan (pending -> scanned) et décrire la session pour
 * l'écran de confirmation. Seul /api/auth/qr-session/:id/approve, appelé après
 * un geste explicite de l'utilisateur, approuve — sans quoi un QR malveillant
 * affiché sous un prétexte quelconque suffirait à voler une session.
 */
const _resolveLogin = (req, res, alanyaID, parsed) => {
  const session = qrLoginSessions.get(parsed.sessionId);
  // Un secret invalide est indistinguable d'une session inconnue : pas de
  // signal exploitable pour énumérer les sessions en cours.
  if (!session || !secretMatches(session.scanSecret, parsed.scanSecret)) {
    return res.status(404).json({ error: 'Session de connexion inconnue ou expirée' });
  }

  qrLoginSessions.markScanned(parsed.sessionId, alanyaID);

  res.json({
    type: 'login',
    session: {
      sessionId:  session.sessionId,
      deviceName: session.deviceName ?? null,
      platform:   session.platform ?? null,
      ipAddress:  session.ipAddress ?? null,
      // Lieu approximatif déduit de l'IP. Null si la géolocalisation n'a pas
      // abouti : l'écran de confirmation retombe alors sur l'adresse brute.
      location:   session.location ?? null,
      createdAt:  _toIso(session.createdAt),
      expiresAt:  _toIso(session.expiresAt),
    },
  });
};

// Point d'entrée unique de tous les QR Alanya
const resolveQr = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;

    const parsed = _parsePayload(req.body?.payload);
    if (!parsed) {
      return res.status(400).json({ error: 'Code QR illisible' });
    }

    if (parsed.type === 'contact') {
      return await _resolveContact(req, res, alanyaID, parsed.qrPublicId);
    }
    return _resolveLogin(req, res, alanyaID, parsed);
  } catch (error) {
    console.error('[resolveQr] ERROR:', error);
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  getMyQr,
  regenerateQr,
  resolveQr,
  identityPayload,
};
