const {
  deliverWelcome,
} = require('../services/welcomeService');

const deliver = async (req, res) => {
  try {
    const locale = req.body?.locale ?? req.headers['accept-language'] ?? 'fr';
    const result = await deliverWelcome(req.user.alanyaID, { locale });
    res.json(result);
  } catch (e) {
    console.error('[Welcome] deliver:', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { deliver };
