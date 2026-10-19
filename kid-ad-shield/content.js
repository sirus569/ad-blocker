// Kid Ad Shield
// Covers the screen and mutes every <video> while an ad plays, then brings the
// show back. It never skips, blocks, seeks past, or speeds up ads.
//
// Two ways to know an ad is playing:
//  - YouTube TV live: server.py holds the commercial breaks found by the
//    detector Chrome. We compare the player's own content timestamp (`ref`,
//    read by page-probe.js) with them. Everything fails toward NOT covering.
//  - Prime Video (and YouTube-inserted ads): the player shows an "Ad" label.
//
// If server.py is unreachable, automatic covering stops (only manual works).
// mode "cover" is the TV Chrome. mode "reporter" (detector Chrome) never covers.

(() => {
  'use strict';

  const POLL_MS = 250;        // cover decision rate (local, no network)
  const SYNC_MS = 500;        // how often to ask the server
  const CLEAR_CHECKS = 3;     // label detection only: "no ad" checks before uncovering (~0.75s)

  // Tunables. Positive values only ever shrink the covered span.
  const START_DELAY = 0.0;    // s after a break's start before covering
  const END_EARLY = 1.5;      // s before a break's end to uncover
  const MAX_COVER_S = 180;    // never cover one break longer than this

  const FAIL_LIMIT = 3;       // consecutive failed syncs = server down
  const STALE_OK_MS = 2500;   // ...or no successful sync for this long
  const PROBE_FRESH_MS = 1000; // a probe older than this is "no reading"

  // mode, enabled and running are per Chrome instance (storage.local); the rest sync.
  // running: cover mode only talks to the server after the user presses Start.
  const LOCAL_DEFAULTS = { mode: 'cover', enabled: true, running: false };
  const DEFAULTS = {
    debug: false,
    message: 'The show will be right back',
  };

  // Elements Prime Video has used for its ad countdown. Amazon renames these
  // occasionally; the text check below is the fallback when they do.
  const AD_SELECTORS = [
    '.atvwebplayersdk-ad-timer',
    '.atvwebplayersdk-ad-timer-text',
    '.atvwebplayersdk-ad-timer-remaining-time',
    '[class*="ad-timer"]',
    '[class*="adTimer"]',
    '[data-testid*="ad-timer"]',
  ];

  // Where to look for an "Ad" label in the player's text.
  const PLAYER_SELECTORS = [
    '.atvwebplayersdk-overlays-container',
    '.webPlayerSDKContainer',
    '.webPlayerContainer',
    '#dv-web-player',
    // YouTube TV (guess: standard YouTube player classes; unverified on tv.youtube.com)
    '.html5-video-player',
    '#movie_player',
  ];

  let settings = { ...DEFAULTS, ...LOCAL_DEFAULTS };
  let covered = false;
  let coveredByLabelOnly = false; // label hits get a short hysteresis, breaks do not
  let manual = false;
  let clearCount = 0;
  let host = null;            // overlay host element
  const mutedByUs = new Set();

  // Server / probe state
  let probe = null;           // latest page-probe reading, with local receive time
  let breaks = [];            // breaks from the last good sync
  let breaksChannel = '';     // channel those breaks belong to
  let detectorAlive = false;
  let failCount = 0;          // consecutive failed syncs
  let lastOkMs = 0;           // when the last sync succeeded (ms, performance.now)
  let everOk = false;
  let breakCoverId = null;    // id of the break we are currently covering for
  let coverReason = '';       // why the screen is covered (shown in the popup)
  let labelDismissed = false; // user pressed Uncover now on a labeled ad: stay off until the label goes
  let breakCoverStart = 0;    // when that cover began (ms)
  const suppressed = new Set(); // break ids that hit MAX_COVER_S: never re-cover

  const log = (...args) => { if (settings.debug) console.log('[Kid Ad Shield]', ...args); };

  // ---------- detection ----------

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function looksLikeAdLabel(text) {
    if (text.length > 30) return false;
    if (/ad[\s-]?free/i.test(text)) return false;
    // "Ad", "Ad 0:15", "Ad · 0:30", "Ads", "Ad 1 of 3" (but not "Add", "Adventure")
    return /^ads?\b/i.test(text) || /\bad\s+\d+\s+of\s+\d+/i.test(text);
  }

  function findPlayer() {
    for (const sel of PLAYER_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function detectAd() {
    for (const sel of AD_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.textContent.trim() && isVisible(el)) return `selector ${sel}`;
      }
    }

    const player = findPlayer();
    if (!player) return null;

    const walker = document.createTreeWalker(player, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue.trim();
      if (text && looksLikeAdLabel(text) && isVisible(node.parentElement)) {
        return `text "${text}"`;
      }
    }
    return null;
  }

  // ---------- muting ----------

  function muteAll() {
    for (const v of document.querySelectorAll('video')) {
      if (!v.muted) {
        v.muted = true;
        mutedByUs.add(v);
      }
    }
  }

  // While covered, re-mute the instant anything (e.g. YouTube's player) un-mutes a
  // video, instead of waiting up to a tick and letting a blip of sound through.
  // volumechange doesn't bubble, so listen in the capture phase.
  document.addEventListener('volumechange', (e) => {
    const v = e.target;
    if (covered && v instanceof HTMLVideoElement && !v.muted) {
      v.muted = true;
      mutedByUs.add(v);
    }
  }, true);

  function unmuteAll() {
    for (const v of mutedByUs) {
      if (v.isConnected) v.muted = false;
    }
    mutedByUs.clear();
  }

  // ---------- overlay ----------

  const OVERLAY_CSS = `
    :host { all: initial; }
    .scene {
      position: fixed; inset: 0; z-index: 2147483647;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 3vh;
      background: radial-gradient(ellipse at 50% 120%, #2B3A78 0%, #1B2552 55%, #121A3B 100%);
      color: #F7F3D6;
      font-family: ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", "Trebuchet MS", system-ui, sans-serif;
      overflow: hidden;
      cursor: default;
    }
    .moon {
      width: 22vmin; height: 22vmin; border-radius: 50%;
      background: #FFE9A8;
      box-shadow: 0 0 6vmin 1vmin rgba(255, 233, 168, 0.35);
      position: relative;
      animation: breathe 6s ease-in-out infinite;
    }
    .moon::after {
      content: ""; position: absolute; border-radius: 50%;
      width: 22vmin; height: 22vmin; top: -3vmin; left: 6vmin;
      background: #1B2552;
    }
    .star {
      position: absolute; width: 0.6vmin; height: 0.6vmin; border-radius: 50%;
      background: #F7F3D6; opacity: 0.7;
    }
    .msg {
      font-size: clamp(28px, 5.5vmin, 72px);
      font-weight: 700; letter-spacing: 0.01em; text-align: center;
      max-width: 80vw; line-height: 1.2;
    }
    .sub {
      font-size: clamp(16px, 2.6vmin, 32px);
      color: #B9C3E8; text-align: center;
    }
    .count {
      font-size: clamp(22px, 4.5vmin, 56px);
      font-weight: 700; color: #FFE9A8; text-align: center;
      font-variant-numeric: tabular-nums;
    }
    .count:empty { display: none; }
    @keyframes breathe {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }
    @media (prefers-reduced-motion: reduce) {
      .moon { animation: none; }
    }
  `;

  const STARS = [
    [12, 18], [22, 70], [35, 12], [48, 82], [63, 22],
    [72, 64], [84, 15], [90, 78], [8, 52], [56, 48],
  ];

  function overlayParent() {
    const fs = document.fullscreenElement;
    // When the player is fullscreen, only its descendants are drawn, so the
    // overlay has to live inside it.
    if (fs && fs.tagName !== 'VIDEO') return fs;
    return document.documentElement;
  }

  function buildOverlay() {
    host = document.createElement('div');
    host.id = 'kid-ad-shield';
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;

    const scene = document.createElement('div');
    scene.className = 'scene';

    for (const [top, left] of STARS) {
      const s = document.createElement('div');
      s.className = 'star';
      s.style.top = `${top}%`;
      s.style.left = `${left}%`;
      scene.appendChild(s);
    }

    const moon = document.createElement('div');
    moon.className = 'moon';

    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = settings.message || DEFAULTS.message;

    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = 'Taking a little break';

    const count = document.createElement('div');
    count.className = 'count'; // "Back in 1:23" during a known break

    scene.append(moon, msg, sub, count);
    root.append(style, scene);
  }

  function setCountdown(text) {
    if (!host) return;
    const el = host.shadowRoot.querySelector('.count');
    if (el && el.textContent !== text) el.textContent = text;
  }

  const mmss = (sec) => {
    const s = Math.max(0, Math.ceil(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  // Text for the countdown while covering for break `b`. Exact when the break's
  // end is known; "Back soon" while it is still open. Never longer than the
  // MAX_COVER_S cap, since the cover lifts then anyway.
  function breakCountdown(b) {
    if (b.end == null) return 'Back soon';
    const ref = currentRef();
    if (ref == null) return 'Back soon';
    const capLeft = MAX_COVER_S - (performance.now() - breakCoverStart) / 1000;
    return `Back in ${mmss(Math.min(b.end - END_EARLY - ref, capLeft))}`;
  }

  function showOverlay() {
    if (!host) buildOverlay();
    const parent = overlayParent();
    if (host.parentNode !== parent) parent.appendChild(host);
  }

  function hideOverlay() {
    if (host && host.parentNode) host.parentNode.removeChild(host);
  }

  function updateMessage() {
    if (!host) return;
    const msg = host.shadowRoot.querySelector('.msg');
    if (msg) msg.textContent = settings.message || DEFAULTS.message;
  }

  // ---------- server and probe ----------

  function sendToBackground(msg, callback) {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) { callback(null); return; } // background asleep or extension reloaded
        callback(resp);
      });
    } catch (_) {
      // Extension was reloaded: this tab's script is orphaned and needs a refresh.
      log('extension context lost; reload this tab');
      callback(null);
    }
  }

  const channelId = () => (location.pathname.match(/^\/watch\/([^/?#]+)/) || [])[1] || '';

  // page-probe.js (page world) sends its reading as a JSON string.
  window.addEventListener('kas-probe', (e) => {
    try {
      probe = JSON.parse(e.detail);
      probe.recv = performance.now();
    } catch (_) { return; /* ignore malformed */ }
    // The offscreen document needs the reading to map frames to `ref`.
    if (settings.mode === 'reporter') {
      sendToBackground({ type: 'probe', probe: { channel: channelId(), ref: probe.ref, wall: probe.wall,
        paused: probe.paused, rect: probe.rect, vw: probe.vw, vh: probe.vh,
        innerW: probe.innerW, innerH: probe.innerH } }, () => {});
    }
  });

  // Content timestamp (`ref`) of what is on screen right now, or null for "no
  // reading" (no probe, API missing, or probe too old to trust).
  function currentRef() {
    if (!probe || probe.ref == null) return null;
    if (performance.now() - probe.recv > PROBE_FRESH_MS) return null;
    return probe.paused === true ? probe.ref : probe.ref + (Date.now() / 1000 - probe.wall);
  }

  function serverHealthy() {
    return everOk && failCount < FAIL_LIMIT && performance.now() - lastOkMs < STALE_OK_MS;
  }

  function syncOnce() {
    if (settings.mode !== 'cover' || !settings.running) return; // stopped: no server contact at all
    const onTv = location.hostname === 'tv.youtube.com';
    const ref = currentRef();
    const msg = onTv
      ? { type: 'sync', channel: channelId(), ref, at_live: probe && probe.at_live === true,
          paused: probe && probe.paused === true }
      : { type: 'health' }; // no probe on this site: just check the server is up
    const channel = channelId();
    sendToBackground(msg, (resp) => {
      if (resp && resp.ok) {
        failCount = 0;
        lastOkMs = performance.now();
        everOk = true;
        if (onTv) {
          breaks = resp.breaks || [];
          breaksChannel = channel;
          detectorAlive = !!resp.detector_alive;
        }
      } else {
        failCount += 1;
        if (failCount >= FAIL_LIMIT) { breaks = []; detectorAlive = false; }
      }
      tick(); // react right away (notably to the server going down)
    });
  }

  // ---------- reporter mode (detector Chrome) ----------

  const FOLLOW_MIN_MS = 10000; // at most one channel-follow navigation per this long

  // The reload that follows a navigation wipes memory, so the debounce lives in
  // sessionStorage (per tab). Without it a failed follow could reload in a loop.
  function followAllowed() {
    try {
      const last = Number(sessionStorage.getItem('kas-last-follow') || 0);
      if (Date.now() - last < FOLLOW_MIN_MS) return false;
      sessionStorage.setItem('kas-last-follow', String(Date.now()));
      return true;
    } catch (_) { return false; } // no storage: never auto-navigate
  }

  function navigateTo(url) { location.assign(url); }

  // Lets the popup tell whether a capture that ended did so because this page
  // was navigated, reloaded or closed.
  window.addEventListener('pagehide', () => {
    if (settings.mode === 'reporter') sendToBackground({ type: 'pagehide' }, () => {});
  });

  function reportOnce() {
    if (settings.mode !== 'reporter' || !settings.enabled || location.hostname !== 'tv.youtube.com') return;
    const channel = channelId();
    if (!channel) return;
    sendToBackground({
      type: 'report', channel, ref: currentRef(),
      at_live: probe && probe.at_live === true, paused: probe && probe.paused === true,
      wall: Date.now() / 1000,
    }, (resp) => {
      const f = resp && resp.ok && resp.follow_channel;
      if (f && f !== channel && /^[\w-]+$/.test(f) && followAllowed()) {
        log('Following the TV to channel', f);
        navigateTo(`https://tv.youtube.com/watch/${f}`);
      }
    });
  }

  // The break (if any) whose span contains the current content position.
  function breakHit() {
    const ref = currentRef();
    if (ref == null || breaksChannel !== channelId()) return null;
    for (const b of breaks) {
      if (suppressed.has(b.id)) continue;
      const started = ref >= b.start + START_DELAY;
      // Open break: end not known yet. Only trust it while the detector is alive.
      const inside = b.end == null ? (started && detectorAlive)
                                   : (started && ref < b.end - END_EARLY);
      if (inside) return b;
    }
    return null;
  }

  // ---------- main loop ----------

  function cover(reason) {
    if (!covered) {
      covered = true;
      log('Ad detected, covering screen. Trigger:', reason);
    }
    coverReason = reason;
    showOverlay();
    muteAll(); // repeated each tick so newly created video elements are caught
  }

  function uncover() {
    covered = false;
    coveredByLabelOnly = false;
    clearCount = 0;
    hideOverlay();
    unmuteAll();
    log('Ad finished, showing the program again.');
  }

  function tick() {
    // The detector Chrome never covers; it only keeps its own sound off (both
    // Chromes play through the same HDMI output).
    if (settings.mode === 'reporter') {
      if (covered) uncover();
      for (const v of document.querySelectorAll('video')) v.muted = true;
      return;
    }

    const healthy = serverHealthy();
    let kind = null;    // 'hard' (manual/break: no hysteresis) or 'label'
    let reason = null;
    let countdown = ''; // only for break covers

    if (manual) {
      kind = 'hard'; reason = 'manual toggle'; // works even with the server down
    } else if (settings.enabled && settings.running && healthy) {
      let hit = breakHit();
      if (hit) {
        const now = performance.now();
        if (breakCoverId !== hit.id) { breakCoverId = hit.id; breakCoverStart = now; }
        else if (now - breakCoverStart >= MAX_COVER_S * 1000) {
          suppressed.add(hit.id); // covered too long: give up on this break for good
          log(`break ${hit.id} hit the ${MAX_COVER_S}s cap; uncovering`);
          hit = null;
        }
      }
      if (hit) {
        kind = 'hard'; reason = `break ${hit.id}`;
        countdown = breakCountdown(hit);
      } else {
        breakCoverId = null;
        const label = detectAd();
        if (!label) labelDismissed = false;
        else if (!labelDismissed) { kind = 'label'; reason = label; }
      }
    } else {
      breakCoverId = null;
    }

    if (kind) {
      clearCount = 0;
      coveredByLabelOnly = kind === 'label';
      cover(reason);
      setCountdown(countdown);
    } else if (covered) {
      // Labels flicker, so they get a short grace period. Breaks and a dead
      // server uncover immediately.
      if (coveredByLabelOnly && healthy) {
        clearCount += 1;
        if (clearCount >= CLEAR_CHECKS) uncover();
      } else {
        uncover();
      }
    }
  }

  // ---------- debugging help ----------

  // Alt+Shift+D during an ad lists elements that look ad-related, so you can
  // add a working selector to AD_SELECTORS if Amazon changes its page.
  // Visits every element, including ones inside shadow roots and same-origin iframes.
  function walkAll(root, visit, info) {
    for (const el of root.querySelectorAll('*')) {
      visit(el);
      if (el.shadowRoot) { info.shadowRoots += 1; walkAll(el.shadowRoot, visit, info); }
      if (el.tagName === 'IFRAME') {
        info.iframes.push(el.src || '(no src)');
        try { if (el.contentDocument) walkAll(el.contentDocument, visit, info); } catch (_) { /* cross-origin */ }
      }
    }
  }

  function dumpCandidates() {
    const rows = [];
    const info = { shadowRoots: 0, iframes: [], videos: 0 };
    const AD_WORD = /\bads?\b|advert|sponsor|commercial/i;
    const AD_CLASS = /(^|[-_\s])ads?([-_\s]|$)|ad-?timer|adtimer|advert|sponsor/i;

    walkAll(document, (el) => {
      if (el.tagName === 'VIDEO') info.videos += 1;
      const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.nodeValue.trim())
        .filter(Boolean)
        .join(' ');
      const aria = el.getAttribute('aria-label') || el.getAttribute('title') || '';
      const testid = el.getAttribute('data-testid') || '';
      const hit =
        AD_CLASS.test(cls) || AD_CLASS.test(testid) ||
        (ownText.length <= 40 && AD_WORD.test(ownText) && !/ad[\s-]?free/i.test(ownText)) ||
        (aria.length <= 60 && AD_WORD.test(aria));
      if (hit) {
        rows.push(
          `<${el.tagName.toLowerCase()}> visible=${isVisible(el)}` +
          (cls ? ` class="${cls.slice(0, 100)}"` : '') +
          (testid ? ` data-testid="${testid}"` : '') +
          (ownText ? ` text="${ownText.slice(0, 40)}"` : '') +
          (aria ? ` label="${aria.slice(0, 60)}"` : '')
        );
      }
    }, info);

    const report = [
      `[Kid Ad Shield] Page: ${location.href.split('?')[0]}`,
      `Videos: ${info.videos}, shadow roots: ${info.shadowRoots}, iframes: ${info.iframes.length}`,
      ...info.iframes.map((s) => `  iframe: ${s.slice(0, 100)}`),
      `Ad-looking elements: ${rows.length}`,
      ...rows.slice(0, 40).map((r) => `  ${r}`),
    ].join('\n');
    console.log(report);
  }

  // Lets you run the dump from the console: pick "Kid Ad Shield" in the
  // console's context dropdown, then type kidAdShieldDump()
  window.kidAdShieldDump = dumpCandidates;

  window.addEventListener('keydown', (e) => {
    if (!e.altKey || !e.shiftKey) return;
    if (e.code === 'KeyK') {
      manual = !manual;
      console.log('[Kid Ad Shield] Manual cover', manual ? 'ON' : 'OFF');
      if (!manual && covered) uncover();
      tick();
      e.preventDefault();
    } else if (e.code === 'KeyD') {
      dumpCandidates();
      e.preventDefault();
    }
  }, true);

  // Popup buttons: a reliable alternative to Alt+Shift+K, which only works when
  // this page has keyboard focus.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'kas-cover-now') {
      manual = true;
      tick();
    } else if (msg.type === 'kas-uncover-now') {
      manual = false;
      if (covered && breakCoverId != null) suppressed.add(breakCoverId); // don't re-cover this break
      if (covered && coveredByLabelOnly) labelDismissed = true;           // nor this labeled ad
      breakCoverId = null;
      if (covered) uncover();
      tick();
    } else if (msg.type !== 'kas-state') {
      return false;
    }
    sendResponse({ mode: settings.mode, running: !!settings.running, covered, reason: covered ? coverReason : '' });
    return false;
  });

  document.addEventListener('fullscreenchange', () => {
    if (covered) showOverlay(); // move the overlay in or out of the fullscreen element
  });

  // ---------- settings ----------

  chrome.storage.local.get(LOCAL_DEFAULTS, (local) => {
    chrome.storage.sync.get(DEFAULTS, (stored) => {
      settings = { ...DEFAULTS, ...stored, ...local };
      console.log('[Kid Ad Shield] Loaded on', location.hostname, settings);
      setInterval(tick, POLL_MS);
      setInterval(syncOnce, SYNC_MS);
      setInterval(reportOnce, SYNC_MS);
    });
  });

  chrome.storage.onChanged.addListener((changes) => {
    for (const [key, { newValue }] of Object.entries(changes)) settings[key] = newValue;
    if (changes.message) updateMessage();
    if (changes.running && !changes.running.newValue) {
      // Stopped: forget everything from the server so a later Start begins clean.
      breaks = []; detectorAlive = false; everOk = false; failCount = 0;
    }
    tick();
  });
})();
