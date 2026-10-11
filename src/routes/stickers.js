// Stickers (type de message 10) — V1a, catalogue officiel. Contrat :
// CONTRAT-STICKERS.md §4. Tout est derrière `sticker_settings.enabled`
// (`requireStickers`) : fermé, tout répond 404.
//
// L'ENVOI n'a pas de route ici : il passe par `message:send` et
// `POST /api/conversations/:id/messages`, via `utils/stickerMessage`.

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireStickers = require('../middleware/requireStickers');
const c = require('../controllers/stickerController');

router.use(auth, requireStickers);

/**
 * @swagger
 * /api/stickers/catalog:
 *   get:
 *     summary: Packs officiels publiés (ETag, 304 si inchangé)
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/catalog', c.getCatalog);

/**
 * @swagger
 * /api/stickers/packs/{code}:
 *   get:
 *     summary: Stickers actifs d'un pack, dans l'ordre
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/packs/:code', c.getPack);

/**
 * @swagger
 * /api/stickers/me:
 *   get:
 *     summary: Packs installés et favoris (ids seulement), un seul appel
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/me', c.getMe);

// `order` AVANT `:id` : sinon « order » serait lu comme un identifiant de pack.
router.put('/me/packs/order', c.putPacksOrder);
router.put('/me/packs/:id', c.putMyPack);
router.delete('/me/packs/:id', c.deleteMyPack);
router.put('/me/favorites/:stickerId', c.putFavorite);
router.delete('/me/favorites/:stickerId', c.deleteFavorite);

module.exports = router;
