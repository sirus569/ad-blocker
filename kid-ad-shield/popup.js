// mode and enabled live in storage.local (per Chrome instance): storage.sync
// would copy the mode between the TV Chrome and the detector Chrome if they
// share a Google account. message and debug can stay in sync.
const LOCAL_DEFAULTS = { mode: 'cover', enabled: true, running: false };
const SYNC_DEFAULTS = { debug: false, message: 'The show will be right back' };

const mode = document.getElementById('mode');
const modeNote = document.getElementById('modeNote');
const enabled = document.getElementById('enabled');
const debug = document.getElementById('debug');
const message = document.getElementById('message');

const NOTES = {
  cover: 'This Chrome covers and mutes during ad breaks. Use it on the TV.',
  reporter: 'This Chrome only watches for breaks and never covers. Use it on the laptop screen.',
};

const coverCtl = document.getElementById('coverCtl');
const runBtn = document.getElementById('runBtn');
const runNote = document.getElementById('runNote');
let running = false;

// Cover mode (TV Chrome): Start/Stop talking to server.py.
function showRunning() {
  runBtn.textContent = running ? 'Stop' : 'Start';
  runNote.textContent = running
    ? 'Running: checking with server.py twice a second and covering breaks.'
    : 'Stopped: not contacting the server and not covering automatically (Alt+Shift+K still works).';
}
runBtn.addEventListener('click', () => {
  running = !running;
  chrome.storage.local.set({ running });
  showRunning();
});

// Cover now / Uncover now: talk to the content script in this window's active tab.
const coverState = document.getElementById('coverState');
async function tabMsg(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  try { return await chrome.tabs.sendMessage(tab.id, { type }); } catch (_) { return null; }
}
function describe(reason) {
  if (reason.startsWith('break')) return 'commercial break detected';
  if (reason.startsWith('manual')) return 'covered by hand';
  return 'ad label on the page';
}
async function refreshCoverState(r) {
  if (r === undefined) r = await tabMsg('kas-state');
  coverState.textContent = !r
    ? 'No Kid Ad Shield on this tab. Open the YouTube TV tab (reload it if the extension was just reloaded).'
    : r.covered ? `Screen is covered: ${describe(r.reason)}.` : 'Screen is not covered.';
}
document.getElementById('coverNow').addEventListener('click', async () => refreshCoverState(await tabMsg('kas-cover-now')));
document.getElementById('uncoverNow').addEventListener('click', async () => refreshCoverState(await tabMsg('kas-uncover-now')));
setInterval(() => { if (!coverCtl.hidden) refreshCoverState(); }, 1000);

const capture = document.getElementById('capture');
const captureNote = document.getElementById('captureNote');
const startCapture = document.getElementById('startCapture');

function showMode(m) {
  mode.value = m;
  modeNote.textContent = NOTES[m] + (enabled.checked ? '' : ' It is currently DISABLED: tick "Enabled" below or it will send nothing.');
  capture.hidden = m !== 'reporter';
  coverCtl.hidden = m !== 'cover';
  if (m === 'cover') refreshCoverState();
  if (m === 'reporter') refreshCapture();
}

// What the last report to the server looked like, to explain a server-side "detector x".
function endedLine(s) {
  if (!s.endedAt) return '';
  const ago = Math.round((Date.now() - s.endedAt) / 1000);
  const rel = s.pageHideAt ? Math.round((s.endedAt - s.pageHideAt) / 1000) : null;
  const why = rel === null ? 'no page unload seen'
    : Math.abs(rel) <= 3 ? `right after the tab unloaded (${rel}s): navigation, reload or close`
    : `${rel}s after the tab last unloaded`;
  return `\nCapture track ended ${ago}s ago (${why}).`;
}

function reportLine(r) {
  if (!r) return '\nNo report sent to the server yet (is the YouTube TV tab in Reporter mode, reloaded, on /watch/<channel>?).';
  const age = Math.round((Date.now() - r.at) / 1000);
  return `\nLast report ${age}s ago: server ${r.serverOk ? 'accepted' : 'UNREACHABLE'}, capture_ok ${r.capture_ok}` +
    ` (offscreen fresh ${r.fresh}, ok ${r.capOk}, ref ${r.hasRef ? 'yes' : 'NO'}, tab ${r.tabId} vs captured ${r.captureTabId})`;
}

// Detector Chrome only: what the capture is doing right now.
function refreshCapture() {
  chrome.runtime.sendMessage({ type: 'capture-status' }, (s) => {
    if (chrome.runtime.lastError || !s) { captureNote.textContent = 'Capture not started.'; return; }
    if (!s.fresh) { captureNote.textContent = 'Capture not running. Open the YouTube TV tab here and press Start capture.'; return; }
    const d = s.diag || {};
    captureNote.textContent = (s.ok ? 'Capture OK' : 'Capture running, waiting for frames or a player reading') +
      ` (${s.w}x${s.h}; frames: time ${d.ct}, count ${d.tvf}; probe ${d.probeOk ? 'ok' : 'none'})` +
      endedLine(s) + reportLine(s.lastReport);
  });
}

// A click here is the user gesture Chrome requires for tab capture.
startCapture.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/tv\.youtube\.com\//.test(tab.url || '')) {
    captureNote.textContent = 'Open the YouTube TV tab in this window first, then press Start capture.';
    return;
  }
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    chrome.runtime.sendMessage({ type: 'start-capture', streamId, tabId: tab.id }, (r) => {
      captureNote.textContent = r && r.ok ? 'Starting...' : `Could not start: ${(r && r.error) || 'no response'}`;
      setTimeout(refreshCapture, 1500);
    });
  } catch (e) {
    captureNote.textContent = `Could not start: ${e.message}`;
  }
});
document.getElementById('openDebug').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('debug.html') });
});
setInterval(() => { if (!capture.hidden) refreshCapture(); }, 1000);

chrome.storage.local.get(LOCAL_DEFAULTS, (s) => {
  enabled.checked = s.enabled;
  running = s.running;
  showRunning();
  showMode(s.mode);
});
chrome.storage.sync.get(SYNC_DEFAULTS, (s) => {
  debug.checked = s.debug;
  message.value = s.message;
});

mode.addEventListener('change', () => {
  showMode(mode.value);
  chrome.storage.local.set({ mode: mode.value });
});
enabled.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: enabled.checked });
  showMode(mode.value);
});
debug.addEventListener('change', () => chrome.storage.sync.set({ debug: debug.checked }));
message.addEventListener('change', () => {
  chrome.storage.sync.set({ message: message.value.trim() || SYNC_DEFAULTS.message });
});
