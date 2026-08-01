const assert = require('assert');
const {
  visibilityToInt,
  visibilityFromDb,
  previewModeToInt,
  previewModeFromDb,
  themeModeToInt,
  themeModeFromDb,
  exportStatusToInt,
  exportStatusFromDb,
  EXPORT_JOB_STATUS,
} = require('../constants/profilePrefs');

assert.strictEqual(visibilityToInt('everyone'), 0);
assert.strictEqual(visibilityToInt('contacts'), 1);
assert.strictEqual(visibilityToInt('nobody'), 2);
assert.strictEqual(visibilityFromDb(1), 'contacts');

assert.strictEqual(previewModeToInt('name_only'), 1);
assert.strictEqual(previewModeFromDb(2), 'generic');

assert.strictEqual(themeModeToInt('dark'), 2);
assert.strictEqual(themeModeFromDb(0), 'system');

assert.strictEqual(exportStatusToInt('ready'), EXPORT_JOB_STATUS.ready);
assert.strictEqual(exportStatusFromDb(3), 'failed');

console.log('profilePrefs constants tests OK');
