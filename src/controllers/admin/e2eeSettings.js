/**
 * Interrupteur du chiffrement de bout en bout, côté administration.
 *
 * Deux crans et une cohorte (migration 094, `e2eeSettingsService`) :
 * publier les clés, puis activer les conversations ; pour les comptes de la
 * liste explicite et ceux du pourcentage.
 *
 * Permissions `settings.read` / `settings.write`, comme le verrouillage
 * d'appareil : la seconde est réservée au super-admin. L'écriture invalide le
 * cache de cette instance ; les autres voient la bascule au plus tard 30
 * secondes après.
 *
 * Les colonnes SQL sont en snake_case, la réponse en camelCase. La conversion
 * vit ici et nulle part ailleurs.
 */

const { fail } = require('../../utils/apiError');
const e2eeSettings = require('../../services/e2eeSettingsService');

/**
 * Forme de réponse commune au GET et au PUT.
 *
 * `updatedAt` est toujours une chaîne : l'époque Unix sert de repère « jamais
 * écrit », c'est-à-dire une base où la migration 094 n'a pas été jouée.
 */
const _payload = (row) => ({
  enrolEnabled: Number(row.enrol_enabled) === 1,
  activateEnabled: Number(row.activate_enabled) === 1,
  cohortPercent: Number(row.cohort_percent) || 0,
  cohortIds: [...e2eeSettings.parseCohortIds(row.cohort_ids)],
  updatedAt: row.updated_at
    ? new Date(row.updated_at).toISOString()
    : new Date(0).toISOString(),
});

// Admin : état de l'interrupteur
const getE2eeSettings = async (req, res) => {
  try {
    res.json(_payload(await e2eeSettings.getE2eeSettings()));
  } catch (error) {
    console.error('[Admin] getE2eeSettings error:', error.message);
    res.status(500).json({ error: 'Erreur serveur', code: 'INTERNAL' });
  }
};

// Super admin : ouvre ou ferme un cran, règle la cohorte
const updateE2eeSettings = async (req, res) => {
  let colonnes;
  try {
    colonnes = e2eeSettings.normaliseMiseAJour(req.body || {});
  } catch (error) {
    // `normaliseMiseAJour` ne lève que des `ReglageInvalide` ; toute autre
    // exception est un défaut, et ne doit pas sortir telle quelle.
    if (error instanceof e2eeSettings.ReglageInvalide) {
      return fail(res, 400, error.code, error.message);
    }
    console.error('[Admin] updateE2eeSettings error:', error.message);
    return res.status(500).json({ error: 'Erreur serveur', code: 'INTERNAL' });
  }

  try {
    const apres = await e2eeSettings.setE2eeSettings(colonnes);
    console.log(
      `[E2EE] interrupteur modifié par admin=${req.user?.alanyaID ?? '-'} : `
        + JSON.stringify(_payload(apres)),
    );
    res.json(_payload(apres));
  } catch (error) {
    console.error('[Admin] updateE2eeSettings error:', error.message);
    res.status(500).json({ error: 'Erreur serveur', code: 'INTERNAL' });
  }
};

module.exports = { getE2eeSettings, updateE2eeSettings };
