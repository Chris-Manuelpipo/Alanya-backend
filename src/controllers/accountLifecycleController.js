const fs = require('fs/promises');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { emitToUser } = require('../utils/userSocketRegistry');
const { loadUserPrivacyPrefs } = require('../services/privacyPrefsService');
const { loadUserAppSettings } = require('../services/appSettingsService');
const { loadUserDndSchedule } = require('../services/dndScheduleService');
const { loadUserNotificationPrefs } = require('../notifications/notificationPrefs');
const {
  EXPORT_JOB_STATUS,
  exportStatusFromDb,
} = require('../constants/profilePrefs');

const EXPORT_DIR = path.join(__dirname, '../../uploads/exports');
const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const _INVALID_URL_VALUES = ['NON DEFINI', 'INDEFINI', 'undefined', 'null', ''];
const sanitizeUrl = (url) => {
  if (!url) return null;
  const trimmed = url.trim();
  if (_INVALID_URL_VALUES.includes(trimmed)) return null;
  if (!trimmed.startsWith('http')) return null;
  return trimmed;
};

const _disconnectAllUserSockets = (io, alanyaID) => {
  if (!io?.sockets?.adapter?.rooms) return 0;
  const room = io.sockets.adapter.rooms.get(`user_${Number(alanyaID)}`);
  if (!room) return 0;
  let closed = 0;
  for (const sid of [...room]) {
    const s = io.sockets.sockets.get(sid);
    if (s) {
      s.disconnect(true);
      closed += 1;
    }
  }
  return closed;
};

const _buildSyncExport = async (alanyaID) => {
  const [users] = await pool.execute(
    `SELECT u.alanyaID, u.nom, u.pseudo, u.alanyaPhone, u.email, u.idPays,
            u.avatar_url, u.bio, u.type_compte, u.created_at,
            p.libelle AS pays_libelle, p.prefix AS pays_prefix
       FROM users u
       LEFT JOIN pays p ON u.idPays = p.idPays
      WHERE u.alanyaID = ? AND u.exclus = 0`,
    [alanyaID],
  );
  if (users.length === 0) return null;

  const profile = {
    ...users[0],
    avatar_url: sanitizeUrl(users[0].avatar_url),
    password: undefined,
  };
  delete profile.password;

  const [preferredContacts] = await pool.execute(
    `SELECT pc.idPrefContact, pc.idFriend, pc.added_via, pc.added_note, pc.created_at,
            u.nom, u.pseudo, u.alanyaPhone
       FROM preferredContact pc
       JOIN users u ON pc.idFriend = u.alanyaID
      WHERE pc.alanyaID = ?`,
    [alanyaID],
  );

  const [blocked] = await pool.execute(
    `SELECT b.idBlock, b.idCallerBlock, b.dateBlock,
            u.nom, u.pseudo, u.alanyaPhone
       FROM blocked b
       JOIN users u ON b.idCallerBlock = u.alanyaID
      WHERE b.alanyaID = ?`,
    [alanyaID],
  );

  const [sessions] = await pool.execute(
    `SELECT id, device_name, platform, login_method, created_at, last_active_at, revoked_at
       FROM appareils
      WHERE alanyaID = ?
      ORDER BY last_active_at DESC`,
    [alanyaID],
  );

  const [conversations] = await pool.execute(
    `SELECT c.conversID, c.isGroup, c.GroupName, c.groupPhoto, c.description,
            c.lastMessageAt, c.lastMessageType, c.lastMessageStatus,
            cp.unreadCount, cp.isPinned, cp.isArchived, cp.role, cp.joinedAt,
            cp.mutedUntil, cp.muteForever, cp.mentionsOnly
       FROM conversation c
       JOIN conv_participants cp ON c.conversID = cp.conversID
      WHERE cp.alanyaID = ?
      ORDER BY cp.isPinned DESC, c.lastMessageAt DESC`,
    [alanyaID],
  );

  const convIds = conversations.map((c) => Number(c.conversID)).filter((id) => id > 0);
  let participantsByConv = new Map();
  if (convIds.length > 0) {
    const ph = convIds.map(() => '?').join(',');
    const [parts] = await pool.execute(
      `SELECT cp.conversID, u.alanyaID, u.nom, u.pseudo, u.alanyaPhone, cp.role, cp.joinedAt
         FROM conv_participants cp
         JOIN users u ON cp.alanyaID = u.alanyaID
        WHERE cp.conversID IN (${ph})`,
      convIds,
    );
    for (const p of parts) {
      const cid = Number(p.conversID);
      if (!participantsByConv.has(cid)) participantsByConv.set(cid, []);
      participantsByConv.get(cid).push({
        alanyaID: p.alanyaID,
        nom: p.nom,
        pseudo: p.pseudo,
        alanyaPhone: p.alanyaPhone,
        role: Number(p.role) || 0,
        joinedAt: p.joinedAt,
      });
    }
  }

  const [privacyPrefs, appSettings, notificationPrefs, dndSchedule] = await Promise.all([
    loadUserPrivacyPrefs(alanyaID),
    loadUserAppSettings(alanyaID),
    loadUserNotificationPrefs(alanyaID),
    loadUserDndSchedule(alanyaID),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    version: 1,
    profile,
    preferredContacts,
    blocked,
    sessions,
    privacyPrefs,
    appSettings,
    notificationPrefs,
    dndSchedule,
    conversations: conversations.map((c) => ({
      ...c,
      lastMessage: undefined,
      participants: participantsByConv.get(Number(c.conversID)) || [],
    })),
  };
};

const _buildFullExport = async (alanyaID) => {
  const base = await _buildSyncExport(alanyaID);
  if (!base) return null;

  const [messages] = await pool.execute(
    `SELECT msgID, senderID, conversationID, content, type, status,
            sendAt, readAt, deliveredAt, mediaUrl, mediaName, mediaDuration,
            isDeleted, isEdited, editedAt, replyToID, clientID
       FROM message
      WHERE senderID = ?
         OR conversationID IN (
           SELECT conversID FROM conv_participants WHERE alanyaID = ?
         )
      ORDER BY conversationID ASC, sendAt ASC`,
    [alanyaID, alanyaID],
  );

  return { ...base, version: 2, messages };
};

const _runExportJob = async (jobId, alanyaID) => {
  try {
    await pool.execute(
      'UPDATE user_export_jobs SET status = ? WHERE id = ? AND status = ?',
      [EXPORT_JOB_STATUS.processing, jobId, EXPORT_JOB_STATUS.pending],
    );

    await fs.mkdir(EXPORT_DIR, { recursive: true });
    const payload = await _buildFullExport(alanyaID);
    if (!payload) {
      throw new Error('Utilisateur introuvable');
    }

    const filename = `export_${alanyaID}_${jobId}.json`;
    const filePath = path.join(EXPORT_DIR, filename);
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');

    const expiresAt = new Date(Date.now() + EXPORT_TTL_MS);
    await pool.execute(
      `UPDATE user_export_jobs
          SET status = ?, filePath = ?, completedAt = NOW(), expiresAt = ?
        WHERE id = ?`,
      [EXPORT_JOB_STATUS.ready, filename, expiresAt, jobId],
    );
  } catch (error) {
    console.error('[AccountExport] job failed:', jobId, error.message);
    await pool.execute(
      'UPDATE user_export_jobs SET status = ?, errorMessage = ?, completedAt = NOW() WHERE id = ?',
      [EXPORT_JOB_STATUS.failed, String(error.message || 'export_failed').slice(0, 2000), jobId],
    );
  }
};

const deleteAccount = async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password) {
      return res.status(400).json({ error: 'Mot de passe requis' });
    }

    const alanyaID = req.user.alanyaID;
    const [rows] = await pool.execute(
      'SELECT password FROM users WHERE alanyaID = ? AND exclus = 0',
      [alanyaID],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur introuvable' });
    }

    const valid = await bcrypt.compare(password, rows[0].password);
    if (!valid) {
      return res.status(401).json({ error: 'Mot de passe incorrect' });
    }

    const io = req.app.get('io');

    const [devices] = await pool.execute(
      'SELECT id, device_id FROM appareils WHERE alanyaID = ? AND revoked_at IS NULL',
      [alanyaID],
    );
    await pool.execute(
      'UPDATE appareils SET revoked_at = NOW() WHERE alanyaID = ? AND revoked_at IS NULL',
      [alanyaID],
    );

    for (const d of devices) {
      emitToUser(io, alanyaID, 'auth:device_revoked', {
        appareilId: d.id,
        deviceId: d.device_id,
        reason: 'account_deleted',
      });
    }
    _disconnectAllUserSockets(io, alanyaID);

    // blocked n'a pas ON DELETE CASCADE sur users
    await pool.execute(
      'DELETE FROM blocked WHERE alanyaID = ? OR idCallerBlock = ?',
      [alanyaID, alanyaID],
    );

    await pool.execute('DELETE FROM users WHERE alanyaID = ?', [alanyaID]);

    res.json({ message: 'Compte supprimé' });
  } catch (error) {
    console.error('[DeleteAccount] ERROR:', error);
    res.status(500).json({ error: error.message || 'Échec de la suppression du compte' });
  }
};

const exportAccountData = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const includeMessages = req.body?.includeMessages === true
      || req.body?.includeMessages === 1
      || req.body?.includeMessages === '1';

    if (!includeMessages) {
      const payload = await _buildSyncExport(alanyaID);
      if (!payload) {
        return res.status(404).json({ error: 'Utilisateur introuvable' });
      }
      return res.json(payload);
    }

    const expiresAt = new Date(Date.now() + EXPORT_TTL_MS);
    const [result] = await pool.execute(
      `INSERT INTO user_export_jobs (alanyaID, status, includeMessages, expiresAt)
       VALUES (?, ?, 1, ?)`,
      [alanyaID, EXPORT_JOB_STATUS.pending, expiresAt],
    );
    const jobId = result.insertId;

    setImmediate(() => {
      _runExportJob(jobId, alanyaID).catch((e) =>
        console.error('[AccountExport] background error:', e.message),
      );
    });

    res.status(202).json({
      jobId,
      status: 'pending',
      message: 'Export en cours. Consultez GET /auth/me/export/:jobId',
    });
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') {
      return res.status(503).json({ error: 'Export async non disponible (migration 034 requise)' });
    }
    console.error('[ExportAccount] ERROR:', error);
    res.status(500).json({ error: error.message || 'Échec de l\'export' });
  }
};

const downloadExportJob = async (req, res) => {
  try {
    const jobId = Number(req.params.jobId);
    if (!Number.isFinite(jobId) || jobId <= 0) {
      return res.status(400).json({ error: 'Identifiant de job invalide' });
    }

    const [rows] = await pool.execute(
      'SELECT * FROM user_export_jobs WHERE id = ? AND alanyaID = ?',
      [jobId, req.user.alanyaID],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Export introuvable' });
    }

    const job = { ...rows[0], status: exportStatusFromDb(rows[0].status) };
    if (job.status === 'pending' || job.status === 'processing') {
      return res.status(202).json({ jobId, status: job.status });
    }
    if (job.status === 'failed') {
      return res.status(500).json({
        jobId,
        status: 'failed',
        error: job.errorMessage || 'export_failed',
      });
    }
    if (job.expiresAt && new Date(job.expiresAt).getTime() < Date.now()) {
      return res.status(410).json({ error: 'Export expiré' });
    }
    if (!job.filePath) {
      return res.status(500).json({ error: 'Fichier d\'export manquant' });
    }

    const absPath = path.join(EXPORT_DIR, path.basename(job.filePath));
    try {
      await fs.access(absPath);
    } catch {
      return res.status(404).json({ error: 'Fichier d\'export introuvable' });
    }

    res.download(absPath, `alanya-export-${jobId}.json`);
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') {
      return res.status(503).json({ error: 'Export async non disponible (migration 034 requise)' });
    }
    console.error('[DownloadExport] ERROR:', error);
    res.status(500).json({ error: error.message || 'Échec du téléchargement' });
  }
};

module.exports = {
  deleteAccount,
  exportAccountData,
  downloadExportJob,
};
