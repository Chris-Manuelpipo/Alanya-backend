// État caméra par réunion : meetingId → { userId: isVideoOff }.
// Implémentation partagée avec meetingMuteStates — voir meetingFlagStore.js.
const { createMeetingFlagStore } = require('./meetingFlagStore');

module.exports = createMeetingFlagStore('meetingVideo');
