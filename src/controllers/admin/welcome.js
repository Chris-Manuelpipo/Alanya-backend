const {
  getAdminWelcomeState,
  saveDraft,
  publishDraft,
  startBackfill,
  countBackfillCandidates,
} = require('../../services/welcomeService');

const getWelcome = async (req, res) => {
  try {
    const state = await getAdminWelcomeState();
    const pendingBackfill = await countBackfillCandidates();
    res.json({ ...state, pendingBackfill });
  } catch (e) {
    console.error('[Admin] getWelcome:', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

const updateDraft = async (req, res) => {
  try {
    const { blocks } = req.body || {};
    if (!Array.isArray(blocks)) {
      return res.status(400).json({ error: 'blocks requis (tableau)' });
    }
    for (const b of blocks) {
      if (!['text', 'image', 'video', 'cta'].includes(b.blockType)) {
        return res.status(400).json({ error: 'blockType invalide' });
      }
    }
    const draft = await saveDraft(blocks, req.user.alanyaID);
    res.json(draft);
  } catch (e) {
    console.error('[Admin] updateWelcomeDraft:', e.message);
    res.status(e.status || 500).json({ error: e.message || 'Erreur serveur' });
  }
};

const publish = async (req, res) => {
  try {
    const active = await publishDraft(req.user.alanyaID);
    res.json(active);
  } catch (e) {
    console.error('[Admin] publishWelcome:', e.message);
    res.status(e.status || 500).json({ error: e.message || 'Erreur serveur' });
  }
};

const backfill = async (req, res) => {
  try {
    const result = await startBackfill(req.user.alanyaID);
    res.json(result);
  } catch (e) {
    console.error('[Admin] welcomeBackfill:', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = {
  getWelcome,
  updateDraft,
  publish,
  backfill,
};
