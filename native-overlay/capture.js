let API = 'http://127.0.0.1:8000';
let API_KEY = '';
let configReady = window.captureIPC.apiConfig().then((cfg) => {
  if (cfg && cfg.apiBase) API = cfg.apiBase;
  if (cfg && cfg.apiKey) API_KEY = cfg.apiKey;
});
function authHeaders(extra = {}) {
  return API_KEY ? Object.assign({ 'X-CallPilot-Key': API_KEY }, extra) : extra;
}

let active = false;
let displayStream = null;
let micStream = null;
let mixedStream = null;
let audioContext = null;
let lastQuestion = '';
let rollingTranscript = '';
let abortController = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJson(path, body) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`${path}: ${await r.text()}`);
  return r.json();
}

async function mixAudio(includeMic) {
  displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  const systemTracks = displayStream.getAudioTracks();
  if (!systemTracks.length) {
    displayStream.getTracks().forEach((t) => t.stop());
    throw new Error('macOS did not provide system audio. Allow Screen & System Audio Recording for CallPilot, then try again.');
  }

  displayStream.getVideoTracks().forEach((t) => t.addEventListener('ended', () => {
    if (active) window.captureIPC.ended('stream-ended');
  }));
  systemTracks.forEach((t) => t.addEventListener('ended', () => {
    if (active) window.captureIPC.ended('audio-ended');
  }));

  audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();
  audioContext.createMediaStreamSource(new MediaStream(systemTracks)).connect(destination);

  if (includeMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      audioContext.createMediaStreamSource(micStream).connect(destination);
    } catch (e) {
      window.captureIPC.error(`Microphone unavailable; continuing with call audio only. ${e.message || e}`);
    }
  }
  mixedStream = destination.stream;
}

function recordSegment(durationMs) {
  return new Promise((resolve, reject) => {
    if (!active || !mixedStream) return resolve(null);
    const chunks = [];
    let rec;
    try {
      const type = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      rec = new MediaRecorder(mixedStream, { mimeType: type });
    } catch (e) { return reject(e); }
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onerror = (e) => reject(e.error || new Error('Recorder error'));
    rec.onstop = () => resolve(chunks.length ? new Blob(chunks, { type: rec.mimeType || 'audio/webm' }) : null);
    rec.start();
    setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, durationMs);
  });
}

async function transcribe(blob) {
  const form = new FormData();
  form.append('file', blob, 'call-segment.webm');
  const r = await fetch(`${API}/transcribe`, { method: 'POST', headers: authHeaders(), body: form, signal: abortController?.signal });
  if (!r.ok) throw new Error(`Transcription failed: ${await r.text()}`);
  return r.json();
}

// Streams the same way the overlay's manual ask box does, but pushes each
// growing partial answer to /overlay/push so the auto-detected question card
// visibly streams too, instead of sitting blank for the full 2-5s until the
// whole answer is ready.
async function answerQuestion(question) {
  if (!question || question === lastQuestion) return;
  lastQuestion = question;

  const response = await fetch(`${API}/ask/stream`, {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ question, provider: 'auto', answer_style: 'short', top_k: 5, call_context: rollingTranscript.slice(-3500) }),
    signal: abortController?.signal
  });
  if (!response.ok || !response.body) throw new Error(`/ask/stream: ${await response.text().catch(() => '')}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answerText = '';
  let confidence = 0;
  let source = null;
  let followUp = null;
  let lastPush = 0;

  const pushState = async (force) => {
    const now = Date.now();
    if (!force && now - lastPush < 200) return; // throttle mid-stream pushes
    lastPush = now;
    await postJson('/overlay/push', { question, answer: answerText, confidence, source, follow_up: followUp });
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sepIndex;
    while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      const eventLine = rawEvent.split('\n').find((l) => l.startsWith('event: '));
      const dataLine = rawEvent.split('\n').find((l) => l.startsWith('data: '));
      if (!eventLine || !dataLine) continue;
      const eventType = eventLine.slice('event: '.length).trim();
      let payload;
      try { payload = JSON.parse(dataLine.slice('data: '.length)); } catch (_) { continue; }

      if (eventType === 'sources') {
        confidence = payload.confidence || 0;
        source = (payload.sources && payload.sources[0]) ? payload.sources[0].filename : null;
        await pushState(true);
      } else if (eventType === 'delta') {
        answerText += payload.text;
        await pushState(false);
      } else if (eventType === 'done') {
        answerText = payload.answer;
        confidence = payload.confidence;
        followUp = payload.follow_up;
        await pushState(true);
      }
    }
  }
}

async function loop(segmentMs) {
  while (active) {
    try {
      const blob = await recordSegment(segmentMs);
      if (!active) break;
      if (!blob || blob.size < 800) continue;
      const t = await transcribe(blob);
      const text = String(t.text || '').trim();
      if (text) rollingTranscript = `${rollingTranscript}\n${text}`.slice(-10000);
      let question = t.question || '';
      if (!question && text) {
        const d = await postJson('/detect-question', { transcript: rollingTranscript.slice(-4500), provider: 'auto' });
        question = d.question || '';
      }
      if (question) await answerQuestion(question);
    } catch (e) {
      if (!active || e.name === 'AbortError') break;
      window.captureIPC.error(e.message || String(e));
      await sleep(2500);
    }
  }
}

async function start(opts={}) {
  if (active) return { ok: true, alreadyActive: true };
  try {
    await configReady;
    abortController = new AbortController();
    rollingTranscript = '';
    lastQuestion = '';
    await mixAudio(opts.includeMic !== false);
    active = true;
    // Nothing gets processed until a segment finishes recording, so this
    // window is pure dead time before transcription/detection/answering even
    // start — 8s was adding up to 8s of latency before anything happened.
    loop(Math.max(3000, Number(opts.segmentMs || 4000)));
    return { ok: true };
  } catch (e) {
    await stop('start-failed');
    return { ok: false, error: e.message || String(e) };
  }
}

async function stop(_reason='manual') {
  active = false;
  try { abortController?.abort(); } catch (_) {}
  for (const s of [displayStream, micStream, mixedStream]) {
    try { s?.getTracks().forEach((t) => t.stop()); } catch (_) {}
  }
  try { await audioContext?.close(); } catch (_) {}
  displayStream = micStream = mixedStream = null;
  audioContext = null;
  abortController = null;
  return { ok: true };
}

window.captureControl = { start, stop };
