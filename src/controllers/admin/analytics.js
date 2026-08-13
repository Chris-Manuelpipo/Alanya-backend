const { fetchAnalyticsData } = require('./analyticsData');

const getAnalytics = async (req, res) => {
  try {
    const data = await fetchAnalyticsData(req.query.from, req.query.to);
    res.json(data);
  } catch (error) {
    console.error('[Admin] getAnalytics error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { getAnalytics };
