const MAX_VIDEO_PARTICIPANTS = 4;
const MAX_AUDIO_PARTICIPANTS = 5;

function maxParticipants(isVideo) {
  return isVideo ? MAX_VIDEO_PARTICIPANTS : MAX_AUDIO_PARTICIPANTS;
}

function maxInvitees(isVideo) {
  return maxParticipants(isVideo) - 1;
}

/** type_media : 0 = vidéo, 1 = audio seul */
function maxParticipantsForMeeting(typeMedia) {
  return typeMedia === 0 ? MAX_VIDEO_PARTICIPANTS : MAX_AUDIO_PARTICIPANTS;
}

module.exports = {
  MAX_VIDEO_PARTICIPANTS,
  MAX_AUDIO_PARTICIPANTS,
  maxParticipants,
  maxInvitees,
  maxParticipantsForMeeting,
};
