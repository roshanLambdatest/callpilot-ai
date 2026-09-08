const SUPPORTED = [
  /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[/?#].*)?$/i,
  /^https:\/\/(?:teams\.microsoft\.com|teams\.live\.com)\//i,
  /^https:\/\/(?:[a-z0-9-]+\.)?zoom\.us\/(?:j|wc|my)\//i,
  /^https:\/\/(?:[a-z0-9-]+\.)?webex\.com\//i,
];

function isSupportedMeetingUrl(url='') {
  return SUPPORTED.some((re) => re.test(String(url).trim()));
}

function looksLikeEndedTitle(title='') {
  const t = String(title).toLowerCase();
  return [
    'you left the meeting', 'meeting ended', 'call ended', 'meeting has ended',
    'you have left', 'rejoin', 'return to home'
  ].some((s) => t.includes(s));
}

function shouldAutoStop({active, hadMeeting, meetingPresent, missingSince, now, graceMs=30000}) {
  if (!active || !hadMeeting || meetingPresent) return false;
  return Number.isFinite(missingSince) && now - missingSince >= graceMs;
}

module.exports = { isSupportedMeetingUrl, looksLikeEndedTitle, shouldAutoStop };
