/**
 * Interrupteur du verrouillage d'appareil, côté administration.
 *
 * Armé, il interdit la connexion par mot de passe depuis un téléphone qui n'est
 * pas déjà enrôlé sur le compte : le QR devient la voie normale d'ajout d'un
 * appareil, la réinitialisation du mot de passe la voie de secours.
 *
 * Deux choix d'exploitation à garder en tête en lisant ce fichier :
 *
 * — Les permissions sont `settings.read` / `settings.write`, déjà existantes.
 *   La seconde est réservée au super-admin (`constants/adminRoles.js`), ce qui
 *   est exactement le niveau voulu pour DÉSARMER un verrou de sécurité.
 * — L'écriture invalide le cache de cette instance ; les autres voient la
 *   bascule au plus tard 30 secondes après (voir securitySettingsService).
 *
 * La colonne SQL est `device_binding_enabled` ; la réponse est en camelCase,
 * comme `admin/settings.js` le fait déjà pour `appName` et `apiUrl`. La
 * conversion vit ici et nulle part ailleurs.
 */

const securitySettings = require('../../services/securitySettingsService');

/**
 * Forme de réponse commune au GET et au PUT.
 *
 * `updatedAt` est toujours une chaîne : l'époque Unix sert de repère « jamais
 * écrit », le seul cas possible étant une base où la migration 084 n'a pas
 * encore été jouée. Un `null` obligerait chaque client à traiter ce cas.
 */
const _payload = (row) => ({
  deviceBindingEnabled: Number(row.device_binding_enabled) === 1,
  updatedAt: row.updated_at
    ? new Date(row.updated_at).toISOString()
    : new Date(0).toISOString(),
});

// Admin : état du verrouillage d'appareil
const getSecuritySettings = async (req, res) => {
  try {
    res.json(_payload(await securitySettings.getSecuritySettings()));
  } catch (error) {
    console.error('[Admin] getSecuritySettings error:', error.message);
    res.status(500).json({ error: 'Erreur serveur', code: 'INTERNAL' });
  }
};

// Super admin : arme ou désarme le verrouillage d'appareil
const updateSecuritySettings = async (req, res) => {
  const { deviceBindingEnabled } = req.body || {};

  // Booléen strict, et non une valeur « vraie » : un `"false"` venu d'un
  // formulaire mal câblé armerait le verrou pour tout le monde.
  if (typeof deviceBindingEnabled !== 'boolean') {
    return res.status(400).json({
      error: 'deviceBindingEnabled doit être un booléen',
      code: 'INVALID_SECURITY_SETTING',
    });
  }

  try {
    res.json(_payload(await securitySettings.setDeviceBindingEnabled(deviceBindingEnabled)));
  } catch (error) {
    console.error('[Admin] updateSecuritySettings error:', error.message);
    res.status(500).json({ error: 'Erreur serveur', code: 'INTERNAL' });
  }
};

module.exports = { getSecuritySettings, updateSecuritySettings };
