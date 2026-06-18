const fs = require('fs/promises');
const path = require('path');

// Paramètres applicatifs (stockés dans un fichier JSON, pas de table)
const _SETTINGS_DEFAULTS = { maintenance: false, appName: 'Alanya', apiUrl: '' };
// __dirname = src/controllers/admin → racine projet = ../../../
const _SETTINGS_FILE = path.join(__dirname, '../../../data/app-settings.json');

const _readSettings = async () => {
  try {
    const raw = await fs.readFile(_SETTINGS_FILE, 'utf8');
    return { ..._SETTINGS_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ..._SETTINGS_DEFAULTS };
  }
};

const _writeSettings = async (settings) => {
  await fs.mkdir(path.dirname(_SETTINGS_FILE), { recursive: true });
  await fs.writeFile(_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
};

// Admin : récupère les paramètres applicatifs (maintenance, appName, apiUrl)
const getSettings = async (req, res) => {
  try {
    res.json(await _readSettings());
  } catch (error) {
    console.error('[Admin] getSettings error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// Super admin : met à jour les paramètres applicatifs (maintenance, appName, apiUrl)
const updateSettings = async (req, res) => {
  try {
    const { maintenance, appName, apiUrl } = req.body;
    const current = await _readSettings();
    const next = { ...current };
    if (typeof maintenance === 'boolean') next.maintenance = maintenance;
    if (typeof appName === 'string')      next.appName = appName;
    if (typeof apiUrl === 'string')       next.apiUrl = apiUrl;

    if (JSON.stringify(next) === JSON.stringify(current)) {
      return res.status(400).json({ error: 'Aucun paramètre à mettre à jour' });
    }
    await _writeSettings(next);
    res.json(next);
  } catch (error) {
    console.error('[Admin] updateSettings error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { getSettings, updateSettings };
