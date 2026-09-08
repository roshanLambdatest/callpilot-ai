const API = 'http://localhost:8000';
const bubble = document.getElementById('bubble');
const panel = document.getElementById('panel');
const collapse = document.getElementById('collapse');
const unread = document.getElementById('unread');
const empty = document.getElementById('empty');
const content = document.getElementById('content');

let expanded = false;
let lastPayload = '';
let lastAnswerKey = '';

function renderMode(nextExpanded) {
  expanded = !!nextExpanded;
  bubble.hidden = expanded;
  panel.hidden = !expanded;
  if (expanded) unread.hidden = true;
}

bubble.addEventListener('click', () => window.callpilot.setExpanded(true));
collapse.addEventListener('click', () => window.callpilot.setExpanded(false));
window.callpilot.onMode(({ expanded }) => renderMode(expanded));

window.callpilot.platformInfo().then((info) => {
  const dot = document.getElementById('statusDot');
  if (info.platform === 'win32' && info.protected) dot.title = 'Capture protection requested';
  else if (info.platform === 'darwin') dot.title = 'Capture protection requested; macOS cannot guarantee exclusion';
  else dot.title = 'Capture exclusion unavailable';
});

function renderState(data) {
  const hasAnswer = !!(data && data.visible && (data.question || data.answer));
  empty.hidden = hasAnswer;
  content.hidden = !hasAnswer;
  if (!hasAnswer) return;

  document.getElementById('question').textContent = data.question || 'Customer question';
  document.getElementById('answer').textContent = data.answer || '';
  document.getElementById('source').textContent = data.source ? `Source · ${data.source}` : 'Knowledge base';
  document.getElementById('confidence').textContent = data.confidence ? `${Math.round(data.confidence * 100)}%` : '';

  const follow = document.getElementById('follow');
  if (data.follow_up) {
    follow.textContent = `Follow-up · ${data.follow_up}`;
    follow.hidden = false;
  } else {
    follow.hidden = true;
  }

  const answerKey = `${data.question || ''}|${data.answer || ''}`;
  if (answerKey !== lastAnswerKey) {
    lastAnswerKey = answerKey;
    if (!expanded) unread.hidden = false;
  }
}

async function poll() {
  try {
    const response = await fetch(`${API}/overlay/state`);
    if (response.ok) {
      const data = await response.json();
      const payload = JSON.stringify(data);
      if (payload !== lastPayload) {
        lastPayload = payload;
        renderState(data);
      }
    }
  } catch (_) {
    // Keep the lightweight bubble alive while the backend recovers.
  }
  setTimeout(poll, 650);
}

renderMode(false);
poll();
