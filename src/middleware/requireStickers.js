const { fail } = require('../utils/apiError');
const { peutUtiliserStickers } = require('../services/stickerSettingsService');

/**
 * Garde des routes `/api/stickers/*` : `sticker_settings.enabled` et cohorte
 * (migration 097).
 *
 * Fermé : 404 `NOT_FOUND` générique, sans code propre aux stickers — rien
 * n'est révélé, la fonctionnalité n'existe pas pour ce compte. Même esprit que
 * `requireE2ee`, sans code dédié : l'application n'a rien à en faire.
 *
 * Table absente ou lecture en échec (`StickerSettingsInaccessibles`) : fermé,
 * 404. La posture diffère de l'envoi (`stickerMessage`), où l'illisible est
 * 503 retryable — une route qui répond 404 n'accuse pas de réception, le
 * client ne marque rien en échec.
 */
async function requireStickers(req, res, next) {
  try {
    if (await peutUtiliserStickers(req.user.alanyaID)) return next();
  } catch (e) {
    console.warn('[stickers] réglages illisibles, fermé :', e.code || e.message);
  }
  return fail(res, 404, 'NOT_FOUND', 'Introuvable');
}

module.exports = requireStickers;
