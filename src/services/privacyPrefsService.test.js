const assert = require('assert');
const {
  loadUserPrivacyPrefs,
  canViewProfileField,
  canAddUser,
  DEFAULT_PREFS,
} = require('./privacyPrefsService');

assert.strictEqual(DEFAULT_PREFS.lastSeenVisibility, 'everyone');
assert.strictEqual(DEFAULT_PREFS.readReceiptsEnabled, 1);
assert.strictEqual(DEFAULT_PREFS.previewMode, 'full');

(async () => {
  assert.strictEqual(await canViewProfileField(5, 5, 'avatar_url'), true);
  assert.strictEqual(await canAddUser(3, 3), true);

  const prefs = await loadUserPrivacyPrefs(999999);
  assert.strictEqual(prefs.lastSeenVisibility, 'everyone');
  assert.strictEqual(prefs.onlineVisibility, 'everyone');
  assert.strictEqual(prefs.addMePolicy, 'everyone');

  console.log('privacyPrefsService tests OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
