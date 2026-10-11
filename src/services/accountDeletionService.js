const pool = require('../config/db');
const { publicFilesOfUser, releasePublicFiles } = require('../utils/mediaFile');
const { releaseRingtones } = require('./ringtoneFiles');
const fs = require('fs/promises');
const path = require('path');

const GRACE_DAYS = 7;
const EXPORT_DIR = path.join(__dirname, '../../uploads/exports');
const SELF_DELETE_REASON = 'self_delete_pending';

const _isPendingSelfDelete = (row) =>
  row.exclus === 1
  && row.exclude_reason === SELF_DELETE_REASON
  && row.delete_scheduled_at
  && new Date(row.delete_scheduled_at).getTime() > Date.now();

const isPendingSelfDeleteRow = _isPendingSelfDelete;

const scheduleAccountDeletion = async (alanyaID) => {
  const scheduledAt = new Date(Date.now() + GRACE_DAYS * 24 * 60 * 60 * 1000);
  await pool.execute(
    `UPDATE users
        SET exclus = 1,
            exclude_reason = ?,
            delete_requested_at = NOW(),
            delete_scheduled_at = ?
      WHERE alanyaID = ? AND exclus = 0`,
    [SELF_DELETE_REASON, scheduledAt, alanyaID],
  );
  return scheduledAt;
};

const cancelAccountDeletion = async (alanyaID) => {
  const [rows] = await pool.execute(
    `SELECT alanyaID, exclus, exclude_reason, delete_scheduled_at
       FROM users WHERE alanyaID = ?`,
    [alanyaID],
  );
  if (rows.length === 0) return false;
  const row = rows[0];
  if (!_isPendingSelfDelete(row)) return false;

  await pool.execute(
    `UPDATE users
        SET exclus = 0,
            exclude_reason = NULL,
            delete_requested_at = NULL,
            delete_scheduled_at = NULL
      WHERE alanyaID = ?`,
    [alanyaID],
  );
  return true;
};

const purgeExpiredAccounts = async () => {
  const [rows] = await pool.execute(
    `SELECT alanyaID FROM users
      WHERE delete_scheduled_at IS NOT NULL
        AND delete_scheduled_at <= NOW()
        AND exclude_reason = ?`,
    [SELF_DELETE_REASON],
  );

  for (const row of rows) {
    try {
      await _purgeUser(Number(row.alanyaID));
    } catch (e) {
      console.error('[AccountDeletion] purge failed:', row.alanyaID, e.message);
    }
  }
  return rows.length;
};

/**
 * Nettoyage des données stickers (type 10) d'un compte supprimé.
 *
 * Les tables de compte (`user_sticker_pack`, `user_sticker_favorite`) portent
 * `alanyaID` et disparaissent avec lui. Les signalements suivent le
 * rapporteur (`reporter_id`), et ceux portant sur un actif du compte aussi.
 * Le contenu privé (V1b) part : packs, stickers et actifs dont `owner_id` est
 * le compte. L'officiel (`owner_id` NULL pour un pack, 0 pour un actif) n'est
 * jamais touché.
 *
 * Migration 097 pas encore jouée : `ER_NO_SUCH_TABLE` laisse le reste de la
 * purge continuer plutôt que de bloquer une suppression de compte.
 */
const _purgeStickers = async (conn, alanyaID) => {
  try {
    await conn.execute('DELETE FROM user_sticker_pack WHERE alanyaID = ?', [alanyaID]);
    await conn.execute('DELETE FROM user_sticker_favorite WHERE alanyaID = ?', [alanyaID]);
    await conn.execute('DELETE FROM sticker_report WHERE reporter_id = ?', [alanyaID]);
    await conn.execute(
      `DELETE r FROM sticker_report r
        JOIN sticker_asset a ON r.asset_id = a.id
       WHERE a.owner_id = ?`,
      [alanyaID],
    );
    // Stickers des packs privés du compte, puis les packs (la cascade les
    // reprendrait), puis les actifs référencés par eux.
    await conn.execute(
      `DELETE s FROM sticker s
        JOIN sticker_pack p ON s.pack_id = p.id
       WHERE p.owner_id = ?`,
      [alanyaID],
    );
    await conn.execute('DELETE FROM sticker_pack WHERE owner_id = ?', [alanyaID]);
    await conn.execute('DELETE FROM sticker_asset WHERE owner_id = ?', [alanyaID]);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return;
    throw e;
  }
};

const _purgeUser = async (alanyaID) => {
  const conn = await pool.getConnection();
  let fichiersPublics = [];
  try {
    await conn.beginTransaction();

    // Photo de profil et annonce du répondeur : lues avant que la ligne (et,
    // par cascade, le réglage du répondeur) ne disparaisse, supprimées après
    // le commit. Ce sont des données personnelles, elles partent avec le compte.
    fichiersPublics = await publicFilesOfUser(conn, alanyaID);

    await conn.execute(
      'DELETE FROM blocked WHERE alanyaID = ? OR idCallerBlock = ?',
      [alanyaID, alanyaID],
    );

    await _purgeStickers(conn, alanyaID);

    const [jobs] = await conn.execute(
      'SELECT filePath FROM user_export_jobs WHERE alanyaID = ?',
      [alanyaID],
    );
    for (const job of jobs) {
      if (!job.filePath) continue;
      try {
        await fs.unlink(path.join(EXPORT_DIR, path.basename(job.filePath)));
      } catch (_) {}
    }

    await conn.execute(
      `UPDATE message SET senderID = NULL WHERE senderID = ?`,
      [alanyaID],
    );

    await conn.execute('DELETE FROM users WHERE alanyaID = ?', [alanyaID]);
    await conn.commit();
    releasePublicFiles(fichiersPublics);
    releaseRingtones(alanyaID, { tout: true });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
};

const startDeletionPurgeScheduler = () => {
  const tick = () => {
    purgeExpiredAccounts().catch((e) =>
      console.error('[AccountDeletion] scheduler error:', e.message),
    );
  };
  tick();
  return setInterval(tick, 60 * 60 * 1000);
};

module.exports = {
  GRACE_DAYS,
  SELF_DELETE_REASON,
  isPendingSelfDeleteRow,
  scheduleAccountDeletion,
  cancelAccountDeletion,
  purgeExpiredAccounts,
  startDeletionPurgeScheduler,
};
