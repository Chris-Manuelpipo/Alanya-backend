const pool = require('../config/db');

/**
 * Purges de rétention jamais mises en place (audit scalabilité,
 * docs/AUDIT_SCALABILITE_2026-08-06.md §2.5) : statuts ordinaires expirés,
 * historique d'appels, journal de connexions, jobs en échec terminal,
 * appareils révoqués, appareils push sans heartbeat, OTP abandonnés.
 *
 * (`statut` de bienvenue est déjà purgé par purgeExpiredWelcomeStatuses,
 * welcomeService.js:529 ; `user_export_jobs` par cleanupExpiredExports,
 * accountLifecycleController.js.)
 *
 * Chaque DELETE est borné par LIMIT : au premier passage sur un arriéré
 * important, plusieurs jours de tick suffisent à le résorber sans jamais
 * tenir un verrou long sur une grosse table. Toutes les colonnes filtrées
 * sont indexées (migration 058).
 */
async function runDataRetentionPurge() {
  const results = {};

  const [statutRes] = await pool.execute(
    `DELETE FROM statut WHERE expiredAt < DATE_SUB(NOW(), INTERVAL 7 DAY) LIMIT 5000`,
  );
  results.statut = statutRes.affectedRows || 0;

  const [callRes] = await pool.execute(
    `DELETE FROM callHistory WHERE created_at < DATE_SUB(NOW(), INTERVAL 12 MONTH) LIMIT 5000`,
  );
  results.callHistory = callRes.affectedRows || 0;

  const [accessRes] = await pool.execute(
    `DELETE FROM userAccess WHERE dateLogin < DATE_SUB(NOW(), INTERVAL 90 DAY) LIMIT 5000`,
  );
  results.userAccess = accessRes.affectedRows || 0;

  const [jobRes] = await pool.execute(
    `DELETE FROM job_queue
       WHERE failed_at IS NOT NULL
         AND failed_at < DATE_SUB(NOW(), INTERVAL 30 DAY)
       LIMIT 5000`,
  );
  results.job_queue = jobRes.affectedRows || 0;

  const [appareilsRes] = await pool.execute(
    `DELETE FROM appareils
       WHERE revoked_at IS NOT NULL
         AND revoked_at < DATE_SUB(NOW(), INTERVAL 90 DAY)
       LIMIT 1000`,
  );
  results.appareils = appareilsRes.affectedRows || 0;

  const [pushRes] = await pool.execute(
    `DELETE FROM user_push_devices
       WHERE lastHeartbeatAt IS NOT NULL
         AND lastHeartbeatAt < DATE_SUB(NOW(), INTERVAL 180 DAY)
       LIMIT 1000`,
  );
  results.user_push_devices = pushRes.affectedRows || 0;

  const [resetOtpRes] = await pool.execute(
    `UPDATE users SET reset_otp = NULL, reset_otp_expires_at = NULL
       WHERE reset_otp_expires_at IS NOT NULL AND reset_otp_expires_at < NOW()`,
  );
  results.reset_otp = resetOtpRes.affectedRows || 0;

  const [emailOtpRes] = await pool.execute(
    `UPDATE users SET email_change_otp = NULL, email_change_otp_expires_at = NULL, pending_email = NULL
       WHERE email_change_otp_expires_at IS NOT NULL AND email_change_otp_expires_at < NOW()`,
  );
  results.email_otp = emailOtpRes.affectedRows || 0;

  const total = Object.values(results).reduce((a, b) => a + b, 0);
  if (total > 0) {
    console.log('[DataRetention] purge:', JSON.stringify(results));
  }
  return results;
}

module.exports = { runDataRetentionPurge };
