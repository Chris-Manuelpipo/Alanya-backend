/**
 * Espace super-admin des purges de rétention.
 *
 * Trois besoins, tous absents jusqu'ici : couper une purge sans redéployer,
 * voir ce qu'elle s'apprête à supprimer avant de la relancer, et savoir si
 * elle tourne vraiment. Le registre (src/services/purgeRegistry.js) porte la
 * logique ; ce contrôleur ne fait que l'exposer.
 */

const registry = require('../../services/purgeRegistry');

const _auteur = (req) => req.user?.email || req.user?.phone || req.user?.alanyaID || null;

/** Admin : état des cinq purges — réglages, volumétrie purgeable, historique. */
const getPurges = async (req, res) => {
  try {
    // `withStats` permet de recharger la page sans repayer les comptages, qui
    // balaient plusieurs tables.
    const withStats = req.query.stats !== '0';
    res.json({ purges: await registry.describeAll({ withStats }) });
  } catch (error) {
    console.error('[Admin] getPurges error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/** Super-admin : activer/désactiver une purge, ou changer ses durées de rétention. */
const updatePurge = async (req, res) => {
  try {
    const { name } = req.params;
    if (!registry.NAMES.includes(name)) {
      return res.status(404).json({ error: 'Purge inconnue' });
    }
    const { enabled, overrides } = req.body || {};
    if (typeof enabled !== 'boolean' && (!overrides || typeof overrides !== 'object')) {
      return res.status(400).json({ error: 'Rien à mettre à jour' });
    }
    const setting = await registry.updateSetting(name, { enabled, overrides }, _auteur(req));
    console.log(
      `[Admin] purge ${name} → ${setting.enabled ? 'activée' : 'DÉSACTIVÉE'} `
      + `par ${_auteur(req) || 'inconnu'} (réglages: ${JSON.stringify(setting.options)})`,
    );
    res.json(setting);
  } catch (error) {
    console.error('[Admin] updatePurge error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * Super-admin : exécution manuelle.
 *
 * Volontairement indépendante de l'interrupteur : couper le balayage
 * automatique tout en gardant la main pour purger ponctuellement est
 * précisément l'usage attendu. L'exécution est journalisée comme `manual`,
 * avec son auteur.
 */
const runPurgeNow = async (req, res) => {
  try {
    const { name } = req.params;
    if (!registry.NAMES.includes(name)) {
      return res.status(404).json({ error: 'Purge inconnue' });
    }
    const { result } = await registry.runPurge(name, { trigger: 'manual', by: _auteur(req) });
    const runs = await registry.listRuns(name, 5);
    res.json({ ok: true, result, runs });
  } catch (error) {
    console.error('[Admin] runPurgeNow error:', error.message);
    res.status(500).json({ error: error.message || 'Erreur serveur' });
  }
};

module.exports = { getPurges, updatePurge, runPurgeNow };
