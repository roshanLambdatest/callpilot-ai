const test = require('node:test');
const assert = require('node:assert/strict');
const { isSupportedMeetingUrl, looksLikeEndedTitle, shouldAutoStop } = require('./meetingLifecycle');

test('recognizes supported meeting URLs', () => {
  assert.equal(isSupportedMeetingUrl('https://meet.google.com/abc-defg-hij'), true);
  assert.equal(isSupportedMeetingUrl('https://teams.microsoft.com/v2/?meetingjoin=true'), true);
  assert.equal(isSupportedMeetingUrl('https://acme.zoom.us/j/123456'), true);
  assert.equal(isSupportedMeetingUrl('https://acme.webex.com/meet/roshan'), true);
});

test('rejects lookalike and unrelated URLs', () => {
  assert.equal(isSupportedMeetingUrl('https://evil.example/?next=meet.google.com/abc-defg-hij'), false);
  assert.equal(isSupportedMeetingUrl('https://meet.google.com/'), false);
  assert.equal(isSupportedMeetingUrl('https://google.com'), false);
});

test('detects common ended titles', () => {
  assert.equal(looksLikeEndedTitle('You left the meeting - Google Meet'), true);
  assert.equal(looksLikeEndedTitle('Customer Discovery | Microsoft Teams'), false);
});

test('auto-stop respects grace period', () => {
  const base = { active: true, hadMeeting: true, meetingPresent: false, missingSince: 1000, graceMs: 30000 };
  assert.equal(shouldAutoStop({ ...base, now: 30999 }), false);
  assert.equal(shouldAutoStop({ ...base, now: 31000 }), true);
});

test('does not auto-stop without confirmed meeting', () => {
  assert.equal(shouldAutoStop({ active: true, hadMeeting: false, meetingPresent: false, missingSince: 0, now: 99999, graceMs: 1000 }), false);
});
