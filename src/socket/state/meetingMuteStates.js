// État mute par réunion : meetingId → { userId: isMuted }.
// Implémentation partagée avec meetingVideoStates — voir meetingFlagStore.js.
const { createMeetingFlagStore } = require('./meetingFlagStore');

module.exports = createMeetingFlagStore('meetingMute');
