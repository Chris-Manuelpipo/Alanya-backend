// État caméra par réunion : meetingId → Map(userId → isVideoOff)
const meetingVideoStates = new Map();

function meetingKey(mID) {
  return String(mID);
}

function getSnapshot(mID, excludeUserId = null) {
  const states = meetingVideoStates.get(meetingKey(mID));
  if (!states) return {};
  const result = {};
  for (const [userId, isVideoOff] of states.entries()) {
    if (excludeUserId != null && userId === String(excludeUserId)) continue;
    result[userId] = isVideoOff;
  }
  return result;
}

function set(mID, userId, isVideoOff) {
  const key = meetingKey(mID);
  if (!meetingVideoStates.has(key)) {
    meetingVideoStates.set(key, new Map());
  }
  meetingVideoStates.get(key).set(String(userId), !!isVideoOff);
}

function removeUser(mID, userId) {
  const key = meetingKey(mID);
  const states = meetingVideoStates.get(key);
  if (!states) return;
  states.delete(String(userId));
  if (states.size === 0) meetingVideoStates.delete(key);
}

function clearMeeting(mID) {
  meetingVideoStates.delete(meetingKey(mID));
}

module.exports = { getSnapshot, set, removeUser, clearMeeting };
