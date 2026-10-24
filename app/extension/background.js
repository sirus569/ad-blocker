// The only place that talks to server.py on this Mac. Chrome blocks web pages
// from reaching localhost, so content scripts ask us instead. Every request
// has a hard 1 s timeout; any failure is reported as { ok: false } and the
// content script treats repeated failures as "server down" (uncover, go idle).
//
// Also (detector Chrome only) owns the tab-capture offscreen document and
// merges its health into the reports sent to the server.

const SERVER = 'http://127.0.0.1:8787';
const TIMEOUT_MS = 1000;
const STATE_STALE_MS = 3000; // offscreen state older than this means capture is not running

async function call(path, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(SERVER + path, { cache: 'no-store', signal: ctl.signal, ...init });
    const j = await r.json();
    return j && j.ok ? j : { ok: false };
  } catch (_) {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

const post = (path, body) => call(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ---------- capture state (from the offscreen document) ----------

let cap = { ok: false, logo: 'none', at: 0 }; // latest state it sent; `at` is when we got it

const captureFresh = () => Date.now() - cap.at < STATE_STALE_MS;

// What the most recent report to the server looked like (shown in the popup for debugging).
let lastReport = null;
let endedAt = 0;      // when the capture track last ended (Chrome stopped the stream)
let pageHideAt = 0;   // when the captured tab's page last unloaded (navigation/reload/close)

function setBadge(ok) {
  chrome.action.setBadgeText({ text: ok ? 'OK' : 'CLICK' });
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#2a7' : '#c60' });
}

async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctx.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Analyze frames of the detector tab',
  });
}

// TV Chrome (cover mode): badge shows ON while Start is active. The detector
// Chrome's badge (OK / CLICK) is driven by capture state instead.
async function coverBadge() {
  const { mode = 'cover', running = false } = await chrome.storage.local.get(['mode', 'running']);
  if (mode !== 'cover') { chrome.action.setBadgeText({ text: '' }); return; } // capture state sets it in reporter mode
  chrome.action.setBadgeText({ text: running ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#2a7' });
}
chrome.runtime.onStartup.addListener(coverBadge);
chrome.runtime.onInstalled.addListener(coverBadge);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.running || changes.mode)) coverBadge();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'sync': {
      // Cover mode on YouTube TV: ask which breaks apply to this channel.
      const q = new URLSearchParams({
        channel: msg.channel || '',
        at_live: msg.at_live ? '1' : '0',
        paused: msg.paused ? '1' : '0',
      });
      if (msg.ref != null) q.set('ref', String(msg.ref));
      call(`/tv/sync?${q}`).then(sendResponse);
      return true; // async response
    }
    case 'health':
      // Pages with no probe (Prime Video): just check the server is up.
      call('/health').then(sendResponse);
      return true;

    case 'report':
      // Reporter mode: heartbeat to the server. capture_ok is only true when the
      // offscreen document says frames are flowing for THIS tab.
      (async () => {
        const { captureTabId } = await chrome.storage.session.get('captureTabId');
        const { program = '' } = await chrome.storage.local.get('program'); // groups breaks per program on the server
        const fresh = captureFresh();
        if (!fresh) setBadge(false);
        const capture_ok = fresh && cap.ok && msg.ref != null &&
          !!sender.tab && sender.tab.id === captureTabId;
        const res = await post('/detector/report', {
          channel: msg.channel, ref: msg.ref, at_live: msg.at_live, paused: msg.paused,
          wall: msg.wall, capture_ok, logo: fresh ? cap.logo : 'none', program,
        });
        lastReport = { at: Date.now(), serverOk: !!res.ok, capture_ok, fresh, capOk: cap.ok,
                       hasRef: msg.ref != null, tabId: sender.tab ? sender.tab.id : null, captureTabId };
        sendResponse(res);
      })();
      return true;

    case 'start-capture':
      // Sent by the popup (user gesture) with a tab-capture stream id.
      (async () => {
        try {
          await ensureOffscreen();
          await chrome.storage.session.set({ captureTabId: msg.tabId });
          await chrome.runtime.sendMessage({ type: 'capture-start', streamId: msg.streamId });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;

    case 'capture-state': // from the offscreen document, twice a second
      cap = { ok: !!msg.ok, logo: msg.logo || 'none', at: Date.now(), diag: msg.diag, w: msg.w, h: msg.h };
      setBadge(cap.ok);
      return false;

    case 'break':
      // From the offscreen detector: a break opened (end_ref null) or closed.
      post('/detector/break', {
        key: msg.key, channel: msg.channel, program: msg.program, start_ref: msg.start_ref, end_ref: msg.end_ref,
      }).then(sendResponse);
      return true;

    case 'trace': // per-second logo scores, for reviewing detection quality
      post('/detector/trace', { channel: msg.channel, thr: msg.thr, baseline: msg.baseline, rows: msg.rows });
      return false;

    // Logo templates live on server.py, one per program (see offscreen.js).
    case 'template-get':
      call(`/template?name=${encodeURIComponent(msg.name)}`).then(sendResponse);
      return true;
    case 'template-set':
      post('/template', { name: msg.name, template: msg.template }).then(sendResponse);
      return true;
    case 'template-delete':
      post('/template', { name: msg.name, template: null }).then(sendResponse);
      return true;
    case 'list-templates': // popup's program list
      call('/templates').then(sendResponse);
      return true;

    // The program being watched (detector Chrome). Kept here because the offscreen
    // document has no chrome.storage; it is told about changes.
    case 'get-program':
      chrome.storage.local.get('program').then((r) => sendResponse({ ok: true, program: r.program || '' }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    case 'set-program':
      chrome.storage.local.set({ program: msg.name || '' })
        .then(() => chrome.runtime.sendMessage({ type: 'program', name: msg.name || '' }).catch(() => {}))
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    case 'trivia': // TV overlay
      call(`/trivia?channel=${encodeURIComponent(msg.channel || '')}`).then(sendResponse);
      return true;

    case 'capture-ended': // from the offscreen document
      endedAt = Date.now();
      return false;

    case 'pagehide': // from content.js in the detector tab, as the page unloads
      (async () => {
        const { captureTabId } = await chrome.storage.session.get('captureTabId');
        if (sender.tab && sender.tab.id === captureTabId) pageHideAt = Date.now();
      })();
      return false;

    case 'capture-status': // popup asking
      sendResponse({ ...cap, fresh: captureFresh(), lastReport, endedAt, pageHideAt });
      return false;

    default:
      return false; // e.g. 'probe' messages are for the offscreen document
  }
});
