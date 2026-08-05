const { listVilles } = require('../../services/villeService');

const getVilles = async (req, res) => {
  try {
    const idPays = Number(req.query.idPays);
    if (!Number.isFinite(idPays) || idPays <= 0) {
      return res.status(400).json({ error: 'idPays requis' });
    }
    const search = String(req.query.search || '').trim();
    const items = await listVilles(idPays, search);
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { getVilles };
