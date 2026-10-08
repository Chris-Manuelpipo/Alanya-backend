/**
 * HEVC par discussion : déclaration des appareils et décision par discussion.
 * La règle elle-même est dans `services/videoCodecs.js`.
 */
const { fail } = require('../utils/apiError');
const {
  conversationAllowsHevc,
  recordDeviceCapabilities,
} = require('../services/videoCodecs');

/**
 * `GET /api/conversations/:id/video-codecs` → `{ hevc }`. Posée après
 * `requireParticipant` : seul un membre peut le demander.
 */
const getConversationVideoCodecs = async (req, res) => {
  const conversID = req.membership?.conversID ?? Number(req.params.id);
  return res.json({ hevc: await conversationAllowsHevc(conversID) });
};

/**
 * `PUT /api/users/me/video-capabilities` `{ hevcDecode }` : ce que l'appareil
 * de la requête sait lire. Répond toujours `ok` quand la demande est bien
 * formée ; `recorded` dit si la ligne de l'appareil a été trouvée.
 */
const putVideoCapabilities = async (req, res) => {
  const { hevcDecode } = req.body || {};
  if (typeof hevcDecode !== 'boolean') {
    return fail(res, 400, 'VALIDATION_FAILED', 'hevcDecode doit être un booléen');
  }
  const recorded = await recordDeviceCapabilities({
    alanyaID: req.user.alanyaID,
    appareilId: req.user.appareilId,
    hevcDecode,
  });
  return res.json({ ok: true, recorded });
};

module.exports = { getConversationVideoCodecs, putVideoCapabilities };
