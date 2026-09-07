const pool = require('../config/db');

/**
 * Journal des délivrances de clé de sauvegarde.
 *
 * ── Pourquoi ce fichier existe ──
 *
 * `GET /api/backup/key` rend la clé qui déchiffre la sauvegarde d'un compte.
 * La conception assume que le serveur puisse déchiffrer — ce n'est pas du bout
 * en bout, et cet arbitrage doit figurer dans la politique de confidentialité —
 * mais elle l'assortit d'une contrepartie : que chaque délivrance laisse une
 * trace consultable.
 *
 * Cette trace existait sous forme de `console.log`. Elle vivait donc dans la
 * sortie du serveur, invisible au panneau d'administration, et disparaissait à
 * la rotation des journaux. Une garantie qu'on ne peut pas produire n'en est
 * pas une.
 *
 * ── Pourquoi l'écriture ne peut jamais faire échouer la requête ──
 *
 * Si la table est pleine, absente ou verrouillée, l'inscrit doit quand même
 * obtenir sa clé : lui refuser sa propre sauvegarde parce qu'un journal est en
 * panne serait un remède pire que le mal. L'échec est donc avalé — mais tracé,
 * sans quoi on croirait le journal complet alors qu'il aurait des trous.
 */

/** Écourte sans jamais dépasser la colonne, et rend `null` sur du vide. */
const _borner = (valeur, max) => {
  const s = (valeur ?? '').toString().trim();
  return s ? s.slice(0, max) : null;
};

/**
 * Enregistre une délivrance, ou son refus.
 *
 * @param {object} req      requête Express, pour l'appelant et son origine
 * @param {number|null} kid version demandée ; `null` = version courante
 * @param {'servie'|'refusee'} outcome
 * @param {string} [reason] motif d'un refus. Jamais le corps de la requête.
 */
async function recordKeyAccess(req, kid, outcome, reason) {
  try {
    await pool.execute(
      `INSERT INTO backup_key_access
         (alanya_id, kid, outcome, reason, ip, device_id, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.alanyaID,
        Number.isInteger(kid) && kid > 0 ? kid : null,
        outcome,
        _borner(reason, 160),
        _borner(req.ip, 64),
        _borner(req.user.appareilId, 64),
        _borner(req.get && req.get('user-agent'), 255),
      ],
    );
  } catch (e) {
    console.error('[BackupKey] ** journalisation impossible:', e.message);
  }
}

module.exports = { recordKeyAccess };
