/**
 * HEVC par discussion.
 *
 * Une vidéo compressée en HEVC pèse un tiers de moins qu'en H.264, à qualité
 * égale ; mais un téléphone ancien ou très bon marché peut ne pas la lire.
 * Chaque téléphone déclare donc ce qu'il lit (`appareils.hevc_decode`, migration
 * 091), et l'app demande, avant d'envoyer une vidéo, si la discussion l'accepte.
 *
 * Règle : la discussion accepte le HEVC si AUCUN membre n'a d'appareil actif qui
 * ne le lit pas, ou n'en a pas dit autant.
 *  - Appareil actif : non révoqué, utilisé dans les `ACTIVE_DAYS` derniers jours.
 *    Un vieux téléphone resté connecté mais oublié ne bloque pas tout le monde.
 *  - `hevc_decode` NULL (ancienne version de l'app) compte comme incapable.
 *  - Un membre sans aucune ligne `appareils` (connecté avant la migration 026,
 *    sans s'être reconnecté depuis) mais vu récemment compte comme incapable :
 *    on ne sait rien de son téléphone.
 *  - L'expéditeur est un membre comme un autre : ses autres appareils comptent.
 *
 * Dans le doute — colonne absente (migration non appliquée), base en panne —
 * c'est non : la vidéo part en H.264, que tout le monde lit.
 */

const pool = require('../config/db');

/** Un appareil sans activité depuis ce délai ne compte plus. */
const ACTIVE_DAYS = 60;

const BLOCKERS_SQL = `
  SELECT COUNT(*) AS bloquants
    FROM conv_participants cp
   WHERE cp.conversID = ?
     AND (
       EXISTS (
         SELECT 1 FROM appareils a
          WHERE a.alanyaID = cp.alanyaID
            AND a.revoked_at IS NULL
            AND a.last_active_at >= (NOW() - INTERVAL ${ACTIVE_DAYS} DAY)
            AND (a.hevc_decode IS NULL OR a.hevc_decode = 0)
       )
       OR (
         NOT EXISTS (
           SELECT 1 FROM appareils a
            WHERE a.alanyaID = cp.alanyaID
              AND a.revoked_at IS NULL
         )
         AND EXISTS (
           SELECT 1 FROM user_presence p
            WHERE p.alanyaID = cp.alanyaID
              AND p.last_seen >= (NOW() - INTERVAL ${ACTIVE_DAYS} DAY)
         )
       )
     )`;

function createVideoCodecs({ db = pool } = {}) {
  /** `true` si une vidéo peut partir en HEVC dans cette discussion. */
  async function conversationAllowsHevc(conversID) {
    try {
      const [rows] = await db.execute(BLOCKERS_SQL, [conversID]);
      return rows.length > 0 && Number(rows[0].bloquants) === 0;
    } catch (err) {
      console.warn('[videoCodecs] décision HEVC impossible, H.264 :', err.code || err.message);
      return false;
    }
  }

  /**
   * Enregistre ce que l'appareil de la requête sait lire. `false` sans appareil
   * identifiable (jeton antérieur à la migration 026) ou en cas d'échec : le
   * téléphone redéclarera à sa prochaine session.
   */
  async function recordDeviceCapabilities({ alanyaID, appareilId, hevcDecode }) {
    if (!appareilId) return false;
    try {
      const [res] = await db.execute(
        'UPDATE appareils SET hevc_decode = ? WHERE id = ? AND alanyaID = ?',
        [hevcDecode ? 1 : 0, appareilId, alanyaID],
      );
      return Number(res?.affectedRows) > 0;
    } catch (err) {
      console.warn('[videoCodecs] capacités non enregistrées :', err.code || err.message);
      return false;
    }
  }

  return { conversationAllowsHevc, recordDeviceCapabilities };
}

const instance = createVideoCodecs();

module.exports = {
  ACTIVE_DAYS,
  BLOCKERS_SQL,
  createVideoCodecs,
  conversationAllowsHevc: instance.conversationAllowsHevc,
  recordDeviceCapabilities: instance.recordDeviceCapabilities,
};
