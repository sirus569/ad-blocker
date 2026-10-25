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
  let moonTotal = null;       // s from that cover's start to its uncover, once the end is known
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
  // Two curtain halves slide in from the sides and slide apart again. Opening for
  // a cover whose end is known starts CURTAIN_S early, so the picture is fully back
  // at the same moment an instant cut would have shown it (never later). Sound is
  // only unmuted at that moment. Unplanned uncovers (server down, Stop, Uncover
  // now) open quickly.

  const CURTAIN_S = 5;        // curtain closing, and planned opening, in seconds
  const QUICK_OPEN_S = 0.6;   // opening when the uncover was not planned
  const TRIVIA_EVERY_S = 21;  // a new trivia question this often while covered (answer up 6 s)
  const OPEN_TRIVIA_EVERY_S = 30; // ...for questions with no answer: 15 s to talk it over
  const ANSWER_AFTER_S = 15;  // reveal the answer this long after the question

  const OVERLAY_CSS = `
    :host { all: initial; }
    .scene {
      position: fixed; inset: 0; z-index: 2147483647;
      overflow: hidden; cursor: default;
      color: #F7F3D6;
      font-family: ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", "Trebuchet MS", system-ui, sans-serif;
      --dur: 5s; --cdelay: 4s;
    }
    .curtain {
      position: absolute; top: 0; bottom: 0; width: 50.5%;
      /* soft vertical folds over the night-sky gradient; each half shows its half of it */
      background:
        repeating-linear-gradient(90deg, rgba(0,0,0,0.10) 0 2.5vmin, rgba(255,255,255,0.03) 2.5vmin 5vmin),
        radial-gradient(ellipse at 50% 120%, #2B3A78 0%, #1B2552 55%, #121A3B 100%);
      background-size: auto, 200% 100%;
      transition: transform var(--dur) ease-in-out;
    }
    .curtain.left  { left: 0;  transform: translateX(-101%); background-position: 0 0, 0 0;
                     box-shadow: inset -1.2vmin 0 2vmin rgba(0,0,0,0.35); }
    .curtain.right { right: 0; transform: translateX(101%);  background-position: 0 0, 100% 0;
                     box-shadow: inset 1.2vmin 0 2vmin rgba(0,0,0,0.35); }
    .scene.closed .curtain { transform: translateX(0); }
    .content {
      position: absolute; inset: 0;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 3vh;
      opacity: 0; transition: opacity 0.4s ease;
    }
    /* text appears once the curtain has (nearly) met in the middle */
    .scene.closed .content { opacity: 1; transition: opacity 1s ease var(--cdelay); }
    /* an SVG moon: half lit (manual/label covers), full ("Back soon") or the break countdown */
    .moon {
      width: 22vmin; height: 22vmin; position: relative;
      animation: breathe 6s ease-in-out infinite;
    }
    .moon svg {
      position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible;
      filter: drop-shadow(0 0 3vmin rgba(255, 233, 168, 0.35));
    }
    .moon.counting { animation: none; }
    .ghost { fill: rgba(255, 233, 168, 0.06); }
    .lit { fill: #FFE9A8; }
    .craters { fill: rgba(196, 166, 96, 0.32); }
    .mtime {
      font-size: 26px; font-weight: 700; text-anchor: middle; dominant-baseline: central;
      font-variant-numeric: tabular-nums;
    }
    .soon .mtime { font-size: 17px; }
    .on-dark { fill: #FFE9A8; }
    .on-lit { fill: #1B2552; }
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
    .trivia { max-width: 70vw; text-align: center; margin-top: 1vh; }
    .tq { font-size: clamp(18px, 3.4vmin, 44px); font-weight: 600; line-height: 1.3; }
    .tq:empty { display: none; }
    .ta { font-size: clamp(16px, 3vmin, 40px); color: #FFE9A8; margin-top: 1.2vh; min-height: 1.3em; }
    /* earlier questions from this game, newest first, along the bottom */
    .recap {
      position: absolute; left: 4vw; right: 4vw; bottom: 4vh;
      display: flex; justify-content: center; gap: 1.6vw;
    }
    .recap:empty { display: none; }
    .card {
      flex: 0 1 min(22vw, 340px);
      background: rgba(18, 26, 59, 0.72); border: 1px solid rgba(247, 243, 214, 0.18);
      border-radius: 1.4vmin; padding: 1.4vmin 1.8vmin;
      font-size: clamp(13px, 1.9vmin, 24px); line-height: 1.3; text-align: left;
    }
    .card .cq { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .card .ca { color: #FFE9A8; margin-top: 0.8vmin; font-weight: 600; }
    .card .ca.open { color: #B9C3E8; font-weight: 400; font-style: italic; }
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

  let opening = false;        // curtain is opening; the overlay is removed when done
  let openEndsAt = 0;         // when the opening finishes (ms, performance.now)
  let openTimer = null;

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
    const left = document.createElement('div');
    left.className = 'curtain left';
    const right = document.createElement('div');
    right.className = 'curtain right';
    const content = document.createElement('div');
    content.className = 'content';

    for (const [top, l] of STARS) {
      const s = document.createElement('div');
      s.className = 'star';
      s.style.top = `${top}%`;
      s.style.left = `${l}%`;
      content.appendChild(s);
    }

    const moon = document.createElement('div');
    moon.className = 'moon';
    // The moon. Its time is drawn twice: yellow over the dark part, and navy
    // clipped to the lit part, so it reads at every phase.
    const svg = svgEl('svg', { viewBox: '-50 -50 100 100' });
    const clip = svgEl('clipPath', { id: 'kas-lit' });
    clip.appendChild(svgEl('path', { class: 'lit-shape', transform: MOON_TILT }));
    // Spots fixed on the moon's face; the shadow passes over them.
    const craters = svgEl('g', { class: 'craters', 'clip-path': 'url(#kas-lit)' });
    for (const [cx, cy, r] of CRATERS) craters.appendChild(svgEl('circle', { cx, cy, r }));
    const defs = svgEl('defs', {});
    defs.appendChild(clip);
    svg.append(defs,
      svgEl('circle', { class: 'ghost', r: MOON_R }),
      svgEl('path', { class: 'lit lit-shape', transform: MOON_TILT }),
      craters,
      svgEl('text', { class: 'mtime on-dark' }),
      svgEl('text', { class: 'mtime on-lit', 'clip-path': 'url(#kas-lit)' }));
    moon.appendChild(svg);

    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = settings.message || DEFAULTS.message;

    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = 'Taking a little break';

    const trivia = document.createElement('div');
    trivia.className = 'trivia';
    const tq = document.createElement('div');
    tq.className = 'tq';
    const ta = document.createElement('div');
    ta.className = 'ta';
    trivia.append(tq, ta);

    const recap = document.createElement('div');
    recap.className = 'recap';

    content.append(moon, msg, sub, trivia, recap);
    scene.append(left, right, content);
    root.append(style, scene);
  }

  const sceneEl = () => host && host.shadowRoot.querySelector('.scene');

  function setDur(scene, s) {
    scene.style.setProperty('--dur', `${s}s`);
    scene.style.setProperty('--cdelay', `${Math.max(0, s - 1)}s`);
  }

  // Close the curtain (or keep it closed). Called every tick while covered.
  function showOverlay() {
    if (!host) buildOverlay();
    const parent = overlayParent();
    if (host.parentNode !== parent) parent.appendChild(host);
    if (openTimer) { clearTimeout(openTimer); openTimer = null; }
    opening = false;
    const scene = sceneEl();
    if (!scene.classList.contains('closed')) {
      setDur(scene, CURTAIN_S);
      void scene.offsetWidth; // apply the open position first so the slide-in runs
      scene.classList.add('closed');
    }
  }

  // Open the curtain over `s` seconds, then remove the overlay. A later call can
  // only make the opening finish sooner, never later.
  function openOverlay(s) {
    if (!host || !host.parentNode) return;
    const scene = sceneEl();
    const now = performance.now();
    if (scene.classList.contains('closed')) {
      setDur(scene, s);
      scene.classList.remove('closed');
      openEndsAt = now + s * 1000;
    } else {
      openEndsAt = opening ? Math.min(openEndsAt, now + s * 1000) : now + s * 1000;
    }
    opening = true;
    if (openTimer) clearTimeout(openTimer);
    openTimer = setTimeout(() => { openTimer = null; if (opening) hideOverlayNow(); },
      Math.max(0, openEndsAt - now) + 100);
  }

  function hideOverlayNow() {
    opening = false;
    if (host && host.parentNode) host.parentNode.removeChild(host);
  }

  function updateMessage() {
    if (!host) return;
    const msg = host.shadowRoot.querySelector('.msg');
    if (msg) msg.textContent = settings.message || DEFAULTS.message;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MOON_R = 48;          // in the moon SVG's 100x100 viewBox
  const MOON_TILT = 'rotate(-45)'; // shadow comes in from the top right, last crescent at the bottom left
  const CRATERS = [           // [cx, cy, r] spots on the moon's lit part
    [-18, -20, 9], [12, -27, 5], [-28, 9, 7], [9, 16, 11],
    [26, -5, 6], [-9, 32, 5], [29, 23, 4], [-35, -9, 3.5], [-14, 18, 3],
  ];

  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  // Lit part of a waning moon with fraction `f` of its area left: the left half
  // disc plus (f > 1/2) or minus (f < 1/2) half an ellipse, so the area is exactly f.
  function litPath(f) {
    const r = MOON_R;
    const k = r * (2 * f - 1);
    return `M 0 ${-r} A ${r} ${r} 0 0 0 0 ${r} A ${Math.abs(k).toFixed(2)} ${r} 0 0 ${k >= 0 ? 0 : 1} 0 ${-r} Z`;
  }

  function setMoonText(el, lines) {
    const key = lines.join('|');
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    el.replaceChildren(...lines.map((line, i) => {
      const t = svgEl('tspan', { x: 0, y: (i - (lines.length - 1) / 2) * 19 });
      t.textContent = line;
      return t;
    }));
  }

  // The moon: half lit with no time (m null: manual and label covers), full and
  // saying "Back soon" while a break's end is unknown, or waning with the time
  // left shown as m:ss.
  function setMoon(m) {
    if (!host) return;
    const root = host.shadowRoot;
    const moon = root.querySelector('.moon');
    moon.classList.toggle('soon', !!m && !!m.soon);
    moon.classList.toggle('counting', !!m && !m.soon);
    const f = !m ? 0.5 : m.soon ? 1 : Math.min(1, Math.max(0, m.frac));
    const d = litPath(f);
    for (const p of root.querySelectorAll('.lit-shape')) {
      if (p.getAttribute('d') !== d) p.setAttribute('d', d);
    }
    const lines = !m ? [] : m.soon ? ['Back', 'soon'] : [mmss(m.left)];
    for (const t of root.querySelectorAll('.mtime')) setMoonText(t, lines);
  }

  const mmss = (sec) => {
    const s = Math.max(0, Math.ceil(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  // Seconds until the cover for break `b` will lift: the break's known end, or
  // the MAX_COVER_S cap, whichever comes first. Without a known end only the cap
  // is certain.
  function secondsUntilUncover(b) {
    const capLeft = MAX_COVER_S - (performance.now() - breakCoverStart) / 1000;
    const ref = currentRef();
    if (b.end == null || ref == null) return capLeft;
    return Math.min(b.end - END_EARLY - ref, capLeft);
  }

  // Countdown for the moon: "Back soon" while the end is open, else the seconds
  // left and the fraction still lit. The cover's whole span is fixed when the end
  // first becomes known, so an end found late starts the moon partly used, and a
  // paused TV holds it still.
  function breakCountdown(b) {
    if (b.end == null || currentRef() == null) return { soon: true };
    const left = secondsUntilUncover(b);
    if (moonTotal == null) moonTotal = (performance.now() - breakCoverStart) / 1000 + left;
    return { left, frac: moonTotal > 0 ? left / moonTotal : 0 };
  }

  // ---------- trivia (from server.py's /trivia; some questions have no answer) ----------

  let trivia = null;          // {q, a, at} on screen; q null = server had none
  let triviaPending = false;

  function fetchTrivia() {
    if (triviaPending) return;
    triviaPending = true;
    sendToBackground({ type: 'trivia', channel: channelId() }, (r) => {
      triviaPending = false;
      trivia = { q: r && r.ok && r.question ? r.question : null, a: (r && r.answer) || null, at: performance.now(),
                 recent: (r && r.ok && Array.isArray(r.recent)) ? r.recent : [] };
      renderTrivia();
      renderRecap();
    });
  }

  function renderTrivia() {
    if (!host) return;
    const q = host.shadowRoot.querySelector('.tq');
    const a = host.shadowRoot.querySelector('.ta');
    const shown = trivia && trivia.q;
    const reveal = shown && performance.now() - trivia.at >= ANSWER_AFTER_S * 1000;
    const qText = shown ? trivia.q : '';
    const aText = !reveal ? '' : trivia.a ? `Answer: ${trivia.a}` : 'No right answer. Talk it over!';
    if (q.textContent !== qText) q.textContent = qText;
    if (a.textContent !== aText) a.textContent = aText;
  }

  // Earlier questions from this game (from the server), newest first.
  function renderRecap() {
    if (!host) return;
    const box = host.shadowRoot.querySelector('.recap');
    const items = (trivia && trivia.recent) || [];
    box.replaceChildren(...items.map((it) => {
      const card = document.createElement('div');
      card.className = 'card';
      const q = document.createElement('div');
      q.className = 'cq';
      q.textContent = it.q;
      const a = document.createElement('div');
      a.className = it.a ? 'ca' : 'ca open';
      a.textContent = it.a ? `A: ${it.a}` : 'Open question';
      card.append(q, a);
      return card;
    }));
  }

  function updateTrivia() {
    const every = trivia && trivia.q && !trivia.a ? OPEN_TRIVIA_EVERY_S : TRIVIA_EVERY_S;
    if (!trivia || performance.now() - trivia.at >= every * 1000) fetchTrivia();
    renderTrivia();
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
    openOverlay(QUICK_OPEN_S); // a planned opening already under way finishes on its own schedule
    unmuteAll();
    trivia = null;             // a fresh question next time
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
    let moon = null;    // break covers only: the countdown (null = half moon)
    let planned = null; // seconds until a break cover will lift (end known or cap)

    if (manual) {
      kind = 'hard'; reason = 'manual toggle'; // works even with the server down
    } else if (settings.enabled && settings.running && healthy) {
      let hit = breakHit();
      if (hit) {
        const now = performance.now();
        if (breakCoverId !== hit.id) { breakCoverId = hit.id; breakCoverStart = now; moonTotal = null; }
        else if (now - breakCoverStart >= MAX_COVER_S * 1000) {
          suppressed.add(hit.id); // covered too long: give up on this break for good
          log(`break ${hit.id} hit the ${MAX_COVER_S}s cap; uncovering`);
          hit = null;
        }
      }
      if (hit) {
        kind = 'hard'; reason = `break ${hit.id}`;
        moon = breakCountdown(hit);
        planned = secondsUntilUncover(hit);
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
      if (planned != null && planned <= CURTAIN_S) {
        // About to lift: open the curtain now so the picture is fully back at the
        // moment we uncover. Sound stays off until then.
        if (!covered) { covered = true; log('Covering (curtain already opening). Trigger:', reason); }
        coverReason = reason;
        muteAll();
        if (!opening) openOverlay(Math.max(planned, 0.1));
      } else {
        cover(reason);
      }
      setMoon(moon);
      updateTrivia();
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
    // move the overlay in or out of the fullscreen element, keeping the curtain's state
    if (host && host.parentNode) { const p = overlayParent(); if (host.parentNode !== p) p.appendChild(host); }
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
