// État mute par réunion : meetingId → Map(userId → isMuted)
const meetingMuteStates = new Map();

function meetingKey(mID) {
  return String(mID);
}

function getSnapshot(mID, excludeUserId = null) {
  const states = meetingMuteStates.get(meetingKey(mID));
  if (!states) return {};
  const result = {};
  for (const [userId, isMuted] of states.entries()) {
    if (excludeUserId != null && userId === String(excludeUserId)) continue;
    result[userId] = isMuted;
  }
  return result;
}

function set(mID, userId, isMuted) {
  const key = meetingKey(mID);
  if (!meetingMuteStates.has(key)) {
    meetingMuteStates.set(key, new Map());
  }
  meetingMuteStates.get(key).set(String(userId), !!isMuted);
}

function removeUser(mID, userId) {
  const key = meetingKey(mID);
  const states = meetingMuteStates.get(key);
  if (!states) return;
  states.delete(String(userId));
  if (states.size === 0) meetingMuteStates.delete(key);
}

function clearMeeting(mID) {
  meetingMuteStates.delete(meetingKey(mID));
}

module.exports = { getSnapshot, set, removeUser, clearMeeting };
