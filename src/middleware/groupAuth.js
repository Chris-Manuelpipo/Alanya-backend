const pool = require('../config/db');

/**
 * Autorisations de conversation / groupe.
 *
 * Il n'existait aucun middleware d'appartenance : chaque contrôleur refaisait
 * son propre `SELECT 1 FROM conv_participants`, de façon inégale — et
 * `updateConversation` ne le faisait pas du tout, ce qui permettait de renommer
 * n'importe quel groupe du système.
 *
 * Ces middlewares ne sont posés que sur les routes NOUVELLES ou CORRIGÉES : on
 * ne réécrit pas les contrôleurs existants qui font déjà leur vérification, pour
 * ne pas mélanger correction de faille et remaniement.
 *
 * Une seule requête, exposée dans `req.membership` — le handler n'a pas à la
 * refaire.
 */

/** Charge l'appartenance de l'appelant, ou null s'il n'est pas membre. */
  async function loadMembership(conversID, alanyaID) {
  const [rows] = await pool.execute(
    `SELECT c.conversID, c.isGroup, c.createdBy,
            c.onlyAdminsCanSend, c.onlyAdminsCanEditInfo,
            c.hideHistoryForNewMembers,
            cp.role
       FROM conversation c
       JOIN conv_participants cp
         ON cp.conversID = c.conversID AND cp.alanyaID = ?
      WHERE c.conversID = ?`,
    [alanyaID, conversID],
  );
  if (rows.length === 0) return null;
  return {
    conversID: Number(rows[0].conversID),
    isGroup: !!rows[0].isGroup,
    createdBy: rows[0].createdBy != null ? Number(rows[0].createdBy) : null,
    onlyAdminsCanSend: !!rows[0].onlyAdminsCanSend,
    onlyAdminsCanEditInfo: !!rows[0].onlyAdminsCanEditInfo,
    hideHistoryForNewMembers: !!rows[0].hideHistoryForNewMembers,
    role: Number(rows[0].role) || 0,
  };
}

/**
 * 404 et non 403 quand on n'est pas membre : un 403 confirmerait l'existence de
 * la conversation à quelqu'un qui n'a rien à y voir.
 */
const requireParticipant = async (req, res, next) => {
  try {
    const conversID = parseInt(req.params.id, 10);
    if (!conversID || conversID < 1) {
      return res.status(400).json({ error: 'Identifiant de conversation invalide' });
    }
    const membership = await loadMembership(conversID, req.user.alanyaID);
    if (!membership) {
      return res.status(404).json({ error: 'Conversation introuvable ou non autorisée' });
    }
    req.membership = membership;
    next();
  } catch (error) {
    next(error);
  }
};

/** À poser APRÈS requireParticipant. */
const requireGroup = (req, res, next) => {
  if (!req.membership?.isGroup) {
    return res.status(400).json({ error: 'Pas un groupe', code: 'NOT_A_GROUP' });
  }
  next();
};

const requireGroupAdmin = [
  requireParticipant,
  requireGroup,
  (req, res, next) => {
    if (req.membership.role < 1) {
      return res.status(403).json({
        error: 'Réservé aux administrateurs du groupe',
        code: 'GROUP_ADMIN_REQUIRED',
      });
    }
    next();
  },
];

const requireGroupOwner = [
  requireParticipant,
  requireGroup,
  (req, res, next) => {
    if (req.membership.role !== 2) {
      return res.status(403).json({
        error: 'Réservé au propriétaire du groupe',
        code: 'GROUP_OWNER_REQUIRED',
      });
    }
    next();
  },
];

module.exports = {
  loadMembership,
  requireParticipant,
  requireGroup,
  requireGroupAdmin,
  requireGroupOwner,
};
