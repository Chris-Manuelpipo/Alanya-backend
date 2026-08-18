/**
 * Rétention des traces de trajet — l'espace d'administration.
 *
 * ⚠ Mêmes règles que `./trips` : cette route ne renvoie JAMAIS d'identité ni de
 * coordonnée. Des compteurs, des durées de rétention, un journal des purges.
 * On y voit combien de traces dorment encore en base, pas où les gens sont
 * allés — et une purge manuelle ne permet pas de viser quelqu'un, seulement
 * d'effacer plus tôt ce que le balayage nocturne effacerait de toute façon.
 *
 * Le journal des purges est un fichier JSON, comme `./settings` : il n'y a pas
 * de table d'audit dans ce projet, et en créer une pour dix lignes coûterait
 * une migration sur une base distante.
 */

const fs = require('fs/promises');
const path = require('path');
const {
  purgeTripPoints,
  fetchTraceRetentionStats,
} = require('../../services/tripRetention');

// __dirname = src/controllers/admin → racine projet = ../../../
const _LOG_FILE = path.join(__dirname, '../../../data/trip-purge-log.json');
const _LOG_MAX = 20;

const _readLog = async () => {
  try {
    const raw = await fs.readFile(_LOG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const _appendLog = async (entry) => {
  const runs = await _readLog();
  runs.unshift(entry);
  await fs.mkdir(path.dirname(_LOG_FILE), { recursive: true });
  await fs.writeFile(_LOG_FILE, JSON.stringify(runs.slice(0, _LOG_MAX), null, 2), 'utf8');
  return runs.slice(0, _LOG_MAX);
};

/** Admin : état de la rétention — ce qui est stocké, ce qui est purgeable. */
const getTripRetention = async (req, res) => {
  try {
    const [stats, runs] = await Promise.all([fetchTraceRetentionStats(), _readLog()]);
    res.json({ ...stats, runs });
  } catch (error) {
    console.error('[Admin] getTripRetention error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

/**
 * Super-admin : purge manuelle.
 *
 *   • `scope: 'retention'` — applique la politique maintenant, sans attendre le
 *     balayage de la nuit. Sans effet de bord : c'est exactement ce que le
 *     serveur ferait tout seul.
 *   • `scope: 'all'` — efface la trace de TOUS les trajets clos, échéance ou
 *     non. Les trajets en cours ne sont jamais touchés : leur trace est le
 *     suivi live, et l'effacer couperait un partage qui protège quelqu'un.
 */
const runTripPurge = async (req, res) => {
  try {
    const scope = req.body?.scope === 'all' ? 'all' : 'retention';
    const result = await purgeTripPoints(null, { ignoreRetention: scope === 'all' });

    const entry = {
      at: new Date().toISOString(),
      scope,
      by: req.user?.email || req.user?.phone || null,
      points: result.points,
      trips: result.trips,
    };
    const runs = await _appendLog(entry);
    console.log(
      `[Admin] purge trace (${scope}) par ${entry.by || 'inconnu'} : `
      + `${result.points} points, ${result.trips} trajets marqués`,
    );

    const stats = await fetchTraceRetentionStats();
    res.json({ ...stats, runs, lastRun: entry });
  } catch (error) {
    console.error('[Admin] runTripPurge error:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

module.exports = { getTripRetention, runTripPurge };
