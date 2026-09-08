const { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray, Menu, nativeImage, Notification, session, desktopCapturer } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const { isSupportedMeetingUrl, looksLikeEndedTitle, shouldAutoStop } = require('./meetingLifecycle');

let win;
let captureWin;
let tray;
let expanded = false;
let callActive = false;
let captureStarting = false;
let hadMeeting = false;
let missingSince = null;
let lastReminder = 0;
let lastDetectedMeeting = null;
let lastError = '';

const COLLAPSED = { width: 62, height: 62 };
const EXPANDED = { width: 430, height: 360 };
const REMINDER_COOLDOWN_MS = 5 * 60 * 1000;
const MEETING_POLL_MS = 7000;
const AUTO_STOP_GRACE_MS = 30000;

// Chromium/Electron 39+ on modern macOS uses Apple's CoreAudio Tap API for desktop audio.
// Keep this app current and include NSAudioCaptureUsageDescription in the packaged Info.plist.

function placeBottomRight(size) {
  if (!win) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const margin = 18;
  win.setBounds({
    x: Math.round(area.x + area.width - size.width - margin),
    y: Math.round(area.y + area.height - size.height - margin),
    width: size.width,
    height: size.height
  }, true);
}

function applyMode(nextExpanded) {
  if (!win) return;
  expanded = !!nextExpanded;
  placeBottomRight(expanded ? EXPANDED : COLLAPSED);
  win.webContents.send('overlay-mode', { expanded });
  if (!win.isVisible()) win.showInactive();
}

function createOverlay() {
  win = new BrowserWindow({
    ...COLLAPSED,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'win32' || process.platform === 'darwin') win.setContentProtection(true);
  win.loadFile('overlay.html');
  win.once('ready-to-show', () => applyMode(false));
  win.on('closed', () => (win = null));
}

async function createCaptureWindow() {
  if (captureWin && !captureWin.isDestroyed()) return captureWin;
  captureWin = new BrowserWindow({
    width: 1,
    height: 1,
    x: -10000,
    y: -10000,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'capture-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  await captureWin.loadFile('capture.html');
  captureWin.on('closed', () => (captureWin = null));
  return captureWin;
}

function trayIcon() {
  const p = path.join(__dirname, 'trayTemplate.png');
  const img = nativeImage.createFromPath(p);
  if (!img.isEmpty()) {
    img.setTemplateImage(true);
    return img.resize({ width: 18, height: 18 });
  }
  return nativeImage.createEmpty();
}

function statusText() {
  if (captureStarting) return 'CallPilot · Starting…';
  if (callActive) return 'CallPilot · Listening';
  if (lastError) return 'CallPilot · Needs attention';
  return 'CallPilot Ready';
}

function rebuildTrayMenu() {
  if (!tray) return;
  const template = [
    { label: statusText(), enabled: false },
    { type: 'separator' },
    { label: 'Start Call', enabled: !callActive && !captureStarting, click: () => startCall('menu') },
    { label: 'Stop Call', enabled: callActive || captureStarting, click: () => stopCall('manual') },
    { type: 'separator' },
    { label: expanded ? 'Minimize Assistant' : 'Open Assistant', click: () => applyMode(!expanded) },
    { label: 'Test Backend', click: () => checkBackend(true) },
    { type: 'separator' },
    { label: 'Quit CallPilot', click: async () => { await stopCall('quit'); app.quit(); } }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(statusText());
}

function notify(title, body) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: false });
    n.show();
    return n;
  } catch (_) {}
}

async function checkBackend(showResult=false) {
  try {
    const r = await fetch('http://127.0.0.1:8000/health');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (showResult) notify('CallPilot', 'Backend and knowledge engine are healthy.');
    return true;
  } catch (e) {
    lastError = `Backend unavailable: ${e.message}`;
    rebuildTrayMenu();
    if (showResult) notify('CallPilot needs attention', 'Backend is not reachable. Restart CallPilot from the menu bar app.');
    return false;
  }
}

async function startCall(source='menu') {
  if (callActive || captureStarting) return;
  captureStarting = true;
  lastError = '';
  rebuildTrayMenu();
  if (!(await checkBackend(false))) {
    captureStarting = false;
    rebuildTrayMenu();
    notify('CallPilot could not start', 'Knowledge backend is unavailable.');
    return;
  }
  try {
    const cw = await createCaptureWindow();
    const result = await cw.webContents.executeJavaScript(`window.captureControl.start(${JSON.stringify({ includeMic: true, segmentMs: 8000 })})`);
    if (!result || !result.ok) throw new Error(result?.error || 'Audio capture did not start');
    callActive = true;
    hadMeeting = !!lastDetectedMeeting;
    missingSince = null;
    captureStarting = false;
    rebuildTrayMenu();
    notify('CallPilot is listening', 'Call audio is being transcribed locally. Answers will appear in the private assistant.');
  } catch (e) {
    callActive = false;
    captureStarting = false;
    lastError = e.message || String(e);
    rebuildTrayMenu();
    notify('CallPilot could not capture audio', `${lastError}\nCheck System Settings → Privacy & Security → Screen & System Audio Recording / Microphone.`);
  }
}

async function stopCall(reason='manual') {
  if (!callActive && !captureStarting) return;
  try {
    if (captureWin && !captureWin.isDestroyed()) {
      await captureWin.webContents.executeJavaScript(`window.captureControl.stop(${JSON.stringify(reason)})`);
    }
  } catch (_) {}
  callActive = false;
  captureStarting = false;
  hadMeeting = false;
  missingSince = null;
  rebuildTrayMenu();
  if (reason !== 'quit') notify('CallPilot stopped', reason === 'meeting-ended' ? 'Meeting ended, so CallPilot stopped automatically.' : 'Call capture has stopped.');
}

function runAppleScript(script) {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 3000 }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
}

async function detectBrowserMeeting() {
  if (process.platform !== 'darwin') return null;
  const chrome = `
    tell application "System Events" to set chromeRunning to exists process "Google Chrome"
    if chromeRunning then
      tell application "Google Chrome"
        repeat with w in windows
          repeat with t in tabs of w
            set u to URL of t
            set n to title of t
            if u contains "meet.google.com/" or u contains "teams.microsoft.com/" or u contains "teams.live.com/" or u contains "zoom.us/" or u contains "webex.com/" then
              return u & linefeed & n
            end if
          end repeat
        end repeat
      end tell
    end if
    return ""
  `;
  const out = await runAppleScript(chrome);
  if (!out.trim()) return null;
  const [url, ...titleParts] = out.trim().split(/\r?\n/);
  const title = titleParts.join(' ');
  if (!isSupportedMeetingUrl(url)) return null;
  if (looksLikeEndedTitle(title)) return null;
  return { url, title };
}

async function monitorMeetings() {
  const meeting = await detectBrowserMeeting();
  const now = Date.now();
  lastDetectedMeeting = meeting;

  if (meeting) {
    missingSince = null;
    if (!callActive && !captureStarting && now - lastReminder > REMINDER_COOLDOWN_MS) {
      lastReminder = now;
      const n = notify('CallPilot is ready', 'A meeting is open. Start Call from the CallPilot menu bar icon.');
      if (n) n.on('click', () => startCall('notification'));
    }
    if (callActive) hadMeeting = true;
  } else if (callActive && hadMeeting) {
    if (missingSince == null) missingSince = now;
    if (shouldAutoStop({ active: callActive, hadMeeting, meetingPresent: false, missingSince, now, graceMs: AUTO_STOP_GRACE_MS })) {
      await stopCall('meeting-ended');
    }
  }
}

app.whenReady().then(async () => {
  // Grant desktop source selection to the capture renderer. On current Electron/macOS,
  // audio capture is provided by Chromium's CoreAudio Tap path when permission is granted.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      if (!sources.length) return callback({});
      callback({ video: sources[0], audio: 'loopback' });
    } catch (_) { callback({}); }
  });

  createOverlay();
  await createCaptureWindow();
  tray = new Tray(trayIcon());
  tray.on('click', () => tray.popUpContextMenu());
  rebuildTrayMenu();
  globalShortcut.register('Alt+Space', () => applyMode(!expanded));
  setInterval(monitorMeetings, MEETING_POLL_MS);
  setTimeout(monitorMeetings, 1500);
});

app.on('will-quit', () => globalShortcut.unregisterAll());

ipcMain.handle('platform-info', () => ({
  platform: process.platform,
  protected: !!win?.isContentProtected?.(),
  guarantee: process.platform === 'win32' ? 'best-supported' : process.platform === 'darwin' ? 'not-guaranteed' : 'unsupported'
}));
ipcMain.on('set-overlay-expanded', (_event, value) => applyMode(!!value));
ipcMain.on('hide-overlay', () => applyMode(false));
ipcMain.on('capture-ended', (_event, reason) => { if (callActive) stopCall(reason || 'stream-ended'); });
ipcMain.on('capture-error', (_event, message) => {
  lastError = String(message || 'Capture error');
  rebuildTrayMenu();
  notify('CallPilot capture issue', lastError);
});
