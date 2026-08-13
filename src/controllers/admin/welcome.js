const {
  getAdminWelcomeState,
  saveDraft,
  publishDraft,
  startBackfill,
  countBackfillCandidates,
  getWelcomeStatusConfig,
  saveWelcomeStatusConfig,
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

/**
 * Statut de bienvenue — réglage global, hors versionnement.
 *
 * Il ne transite pas par le brouillon : `PUT` prend effet immédiatement, ce qui
 * est le comportement attendu d'un interrupteur.
 */
const getStatusConfig = async (req, res) => {
  try {
    res.json(await getWelcomeStatusConfig());
  } catch (e) {
    console.error('[Admin] getWelcomeStatus:', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

const updateStatusConfig = async (req, res) => {
  try {
    const config = await saveWelcomeStatusConfig(req.body || {}, req.user.alanyaID);
    res.json(config);
  } catch (e) {
    console.error('[Admin] updateWelcomeStatus:', e.message);
    res.status(e.status || 500).json({ error: e.message || 'Erreur serveur' });
  }
};

module.exports = {
  getWelcome,
  updateDraft,
  publish,
  backfill,
  getStatusConfig,
  updateStatusConfig,
};
