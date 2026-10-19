// Throwaway spike. Clicking the toolbar icon on the YouTube TV tab starts a
// tabCapture stream consumed by an offscreen document (no popup needed).
// Status goes to the toolbar badge and to a log page (right-click icon -> Options).

let chain = Promise.resolve();
function log(msg) {
  console.log(msg);
  const line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
  // Serialize appends so concurrent log() calls don't overwrite each other.
  chain = chain.then(async () => {
    const { log = [] } = await chrome.storage.local.get('log');
    log.push(line);
    await chrome.storage.local.set({ log: log.slice(-500) });
  });
}

function badge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    await chrome.storage.session.set({ tabId: tab.id });
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!ctx.length) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: 'Analyze frames of the captured tab',
      });
    }
    chrome.runtime.sendMessage({ type: 'start', streamId });
    log(`START capture of tab ${tab.id} ${tab.url}`);
    badge('...', '#888');
  } catch (e) {
    log(`START FAILED: ${e.message}`);
    badge('ERR', '#c00');
  }
});

// Alt+Shift+N: full navigation of the captured tab to its current URL, to see
// whether the capture stream survives the page being replaced.
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'nav') return;
  const { tabId } = await chrome.storage.session.get('tabId');
  if (tabId == null) return log('NAV ignored: no captured tab');
  const tab = await chrome.tabs.get(tabId);
  log(`NAV: navigating tab ${tabId} to ${tab.url}`);
  await chrome.tabs.update(tabId, { url: tab.url });
});

let last = '';
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'event') return log(`EVENT ${msg.text}`);
  if (msg.type !== 'stat') return;
  const state = msg.sd < 2 ? 'BLK' : msg.still >= 20 ? 'STILL' : 'OK';
  if (state !== last) {
    log(`STATE ${last || '-'} -> ${state}`);
    last = state;
    badge(state, state === 'OK' ? '#2a7' : '#c60');
  }
  // One detail line every ~10 s.
  if (msg.n % 20 === 0) {
    log(`stat n=${msg.n} up=${msg.up}s ${msg.w}x${msg.h} sd=${msg.sd.toFixed(1)} ` +
        `motion=${msg.motion.toFixed(2)} still=${msg.still} hidden=${msg.hidden} track=${msg.track}`);
  }
});
