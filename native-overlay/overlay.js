let API = 'http://127.0.0.1:8000';
let API_KEY = '';
function apiFetch(path, opts = {}) {
  const headers = Object.assign({}, opts.headers);
  if (API_KEY) headers['X-CallPilot-Key'] = API_KEY;
  return fetch(`${API}${path}`, Object.assign({}, opts, { headers }));
}

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

// -webkit-app-region:drag on a clickable element eats its click events on
// some Electron/macOS combinations, so the bubble's drag is driven manually:
// small mouse movement while the button is held moves the window; releasing
// without meaningful movement is treated as a click.
const DRAG_THRESHOLD = 4;
let dragging = false;
let dragMoved = false;
let dragStartX = 0;
let dragStartY = 0;

bubble.addEventListener('mousedown', (e) => {
  dragging = true;
  dragMoved = false;
  dragStartX = e.screenX;
  dragStartY = e.screenY;
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const dx = e.screenX - dragStartX;
  const dy = e.screenY - dragStartY;
  if (dragMoved || Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
    dragMoved = true;
    window.callpilot.dragBy(dx, dy);
    dragStartX = e.screenX;
    dragStartY = e.screenY;
  }
});

window.addEventListener('mouseup', () => {
  if (dragging && !dragMoved) window.callpilot.setExpanded(true);
  dragging = false;
});

collapse.addEventListener('click', () => window.callpilot.setExpanded(false));
window.callpilot.onMode(({ expanded }) => renderMode(expanded));

window.callpilot.platformInfo().then((info) => {
  let protectionTitle;
  if (info.platform === 'win32' && info.protected) protectionTitle = 'Hidden from screen shares';
  else if (info.platform === 'darwin') protectionTitle = 'Hidden from screen shares (macOS does not formally guarantee exclusion)';
  else protectionTitle = 'Screen-share exclusion unavailable on this platform';
  document.getElementById('brandIcon').title = protectionTitle;
});

const CALL_STATUS_COPY = {
  idle: {
    title: 'CallPilot is ready',
    hint: "Click Start Call from the CallPilot menu bar icon when you're on a call."
  },
  starting: {
    title: 'Starting…',
    hint: 'Requesting system audio and microphone access.'
  },
  listening: {
    title: 'Listening for questions',
    hint: 'Answers will appear here when a customer asks a question.'
  },
  error: {
    title: 'Capture needs attention',
    hint: 'Check System Settings → Privacy & Security → Screen & System Audio Recording / Microphone, then Start Call again.'
  }
};

const emptyIcon = document.getElementById('emptyIcon');
const emptyTitle = document.getElementById('emptyTitle');
const emptyHint = document.getElementById('emptyHint');
const statusDot = document.getElementById('statusDot');

function renderCallStatus(status) {
  const state = (status && status.state) in CALL_STATUS_COPY ? status.state : 'idle';
  const copy = CALL_STATUS_COPY[state];
  emptyTitle.textContent = copy.title;
  emptyHint.textContent = state === 'error' && status.message ? `${status.message} ${copy.hint}` : copy.hint;
  emptyIcon.className = `emptyIcon state-${state}`;
  statusDot.className = `statusDot state-${state}`;
  statusDot.title = state === 'error' ? (status.message || 'Capture needs attention') : copy.title;
}

window.callpilot.getCallStatus().then(renderCallStatus);
window.callpilot.onCallStatus(renderCallStatus);

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
    const response = await apiFetch('/overlay/state');
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

// -- Conversational Q&A: lets the rep type a question directly instead of
// waiting for the transcript-detected one above.
const scrollArea = document.getElementById('scrollArea');
const askLog = document.getElementById('askLog');
const askForm = document.getElementById('askForm');
const askInput = document.getElementById('askInput');
const askSend = document.getElementById('askSend');

const askHistory = [];

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function renderAskLog() {
  if (!askHistory.length) {
    askLog.hidden = true;
    askLog.innerHTML = '';
    return;
  }
  askLog.hidden = false;
  askLog.innerHTML = askHistory.map((entry) => {
    if (entry.loading) {
      return `<div class="askEntry"><div class="askQ">${escapeHtml(entry.question)}</div><div class="askA loading">Thinking…</div></div>`;
    }
    if (entry.error) {
      return `<div class="askEntry"><div class="askQ">${escapeHtml(entry.question)}</div><div class="askA error">${escapeHtml(entry.error)}</div></div>`;
    }
    const metaParts = [];
    if (entry.source) metaParts.push(`Source · ${escapeHtml(entry.source)}`);
    if (typeof entry.confidence === 'number') metaParts.push(`${Math.round(entry.confidence * 100)}%`);
    const meta = metaParts.length ? `<div class="askMeta"><span>${metaParts.join('</span><span>')}</span></div>` : '';
    const follow = entry.follow_up ? `<div class="follow">Follow-up · ${escapeHtml(entry.follow_up)}</div>` : '';
    return `<div class="askEntry"><div class="askQ">${escapeHtml(entry.question)}</div><div class="askA">${escapeHtml(entry.answer)}</div>${follow}${meta}</div>`;
  }).join('');
  scrollArea.scrollTop = scrollArea.scrollHeight;
}

async function submitAsk(question) {
  const entry = { question, loading: true };
  askHistory.push(entry);
  renderAskLog();

  try {
    const response = await apiFetch('/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      entry.loading = false;
      entry.error = (data && data.detail) || 'Could not get an answer. Try again.';
    } else {
      entry.loading = false;
      entry.answer = data.answer || '';
      entry.confidence = data.confidence;
      entry.follow_up = data.follow_up;
      entry.source = data.sources && data.sources[0] ? data.sources[0].filename : null;
    }
  } catch (_) {
    entry.loading = false;
    entry.error = 'CallPilot backend is unreachable.';
  }
  renderAskLog();
}

askForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const question = askInput.value.trim();
  if (!question || askSend.disabled) return;
  askInput.value = '';
  askSend.disabled = true;
  submitAsk(question).finally(() => {
    askSend.disabled = false;
    askInput.focus();
  });
});

renderMode(false);
window.callpilot.apiConfig().then((cfg) => {
  if (cfg && cfg.apiBase) API = cfg.apiBase;
  if (cfg && cfg.apiKey) API_KEY = cfg.apiKey;
  poll();
});
