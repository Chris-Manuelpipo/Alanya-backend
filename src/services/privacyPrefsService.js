const pool = require('../config/db');
const {
  visibilityToInt,
  visibilityFromDb,
  previewModeToInt,
  previewModeFromDb,
} = require('../constants/profilePrefs');
const { isOfficialAccount } = require('../utils/officialAccountGuard');

const VISIBILITY_VALUES = new Set(['everyone', 'contacts', 'nobody']);
const PREVIEW_VALUES = new Set(['full', 'name_only', 'generic']);

const DEFAULT_PREFS = Object.freeze({
  lastSeenVisibility: 'everyone',
  onlineVisibility: 'everyone',
  readReceiptsEnabled: 1,
  profilePhotoVisibility: 'everyone',
  addMePolicy: 'everyone',
  previewMode: 'full',
});

const _normalizeRow = (row) => ({
  ...row,
  lastSeenVisibility: visibilityFromDb(row.lastSeenVisibility),
  onlineVisibility: visibilityFromDb(row.onlineVisibility),
  profilePhotoVisibility: visibilityFromDb(row.profilePhotoVisibility),
  addMePolicy: visibilityFromDb(row.addMePolicy),
  previewMode: previewModeFromDb(row.previewMode),
});

const loadUserPrivacyPrefs = async (alanyaID) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM user_privacy_prefs WHERE alanyaID = ?',
      [alanyaID],
    );
    if (rows.length === 0) return { ...DEFAULT_PREFS };
    return { ...DEFAULT_PREFS, ..._normalizeRow(rows[0]) };
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return { ...DEFAULT_PREFS };
    throw e;
  }
};

const FIELD_PREF_MAP = Object.freeze({
  avatar_url: 'profilePhotoVisibility',
  last_seen: 'lastSeenVisibility',
  is_online: 'onlineVisibility',
});

const _isContactOf = async (targetId, viewerId) => {
  const [rows] = await pool.execute(
    'SELECT 1 FROM preferredContact WHERE alanyaID = ? AND idFriend = ? LIMIT 1',
    [targetId, viewerId],
  );
  return rows.length > 0;
};

const _passesVisibility = (level, isSelf, isContact) => {
  if (isSelf) return true;
  if (level === 'everyone') return true;
  if (level === 'nobody') return false;
  return isContact;
};

/**
 * Le viewer peut-il voir un champ de profil du target ?
 * field ∈ avatar_url | last_seen | is_online
 */
const canViewProfileField = async (viewerId, targetId, field) => {
  if (viewerId == null || targetId == null) return false;
  if (Number(viewerId) === Number(targetId)) return true;

  const prefKey = FIELD_PREF_MAP[field];
  if (!prefKey) return true;

  const prefs = await loadUserPrivacyPrefs(targetId);
  const level = prefs[prefKey] || 'everyone';
  if (level === 'everyone') return true;
  if (level === 'nobody') return false;

  return _isContactOf(targetId, viewerId);
};

/** L'acteur peut-il ajouter la cible à une conversation / un groupe ? */
const canAddUser = async (actorId, targetId) => {
  if (Number(actorId) === Number(targetId)) return true;

  // Le compte officiel diffuse, il ne converse pas : il n'entre ni dans un
  // groupe ni dans une conversation créée par un tiers. Sa conversation 1-1
  // naît de la matérialisation d'une diffusion, jamais d'une initiative
  // d'utilisateur. Ce point couvre les trois appelants — createConversation,
  // createGroup et addParticipants.
  if (await isOfficialAccount(targetId)) return false;

  const prefs = await loadUserPrivacyPrefs(targetId);
  const policy = prefs.addMePolicy || 'everyone';
  if (policy === 'everyone') return true;
  if (policy === 'nobody') return false;

  return _isContactOf(targetId, actorId);
};

const upsertUserPrivacyPrefs = async (alanyaID, patch = {}) => {
  const current = await loadUserPrivacyPrefs(alanyaID);
  const next = { ...current, ...patch };
  await pool.execute(
    `INSERT INTO user_privacy_prefs
       (alanyaID, lastSeenVisibility, onlineVisibility, readReceiptsEnabled,
        profilePhotoVisibility, addMePolicy, previewMode)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       lastSeenVisibility = VALUES(lastSeenVisibility),
       onlineVisibility = VALUES(onlineVisibility),
       readReceiptsEnabled = VALUES(readReceiptsEnabled),
       profilePhotoVisibility = VALUES(profilePhotoVisibility),
       addMePolicy = VALUES(addMePolicy),
       previewMode = VALUES(previewMode),
       updatedAt = NOW()`,
    [
      alanyaID,
      visibilityToInt(next.lastSeenVisibility),
      visibilityToInt(next.onlineVisibility),
      next.readReceiptsEnabled ? 1 : 0,
      visibilityToInt(next.profilePhotoVisibility),
      visibilityToInt(next.addMePolicy),
      previewModeToInt(next.previewMode),
    ],
  );
  return next;
};

module.exports = {
  VISIBILITY_VALUES,
  PREVIEW_VALUES,
  DEFAULT_PREFS,
  FIELD_PREF_MAP,
  loadUserPrivacyPrefs,
  upsertUserPrivacyPrefs,
  canViewProfileField,
  canAddUser,
  _passesVisibility,
  _isContactOf,
  _normalizeRow,
};
