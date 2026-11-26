// Kid Ad Shield
// Covers the screen and mutes every <video> while an ad plays, then brings the
// show back. It never skips, blocks, seeks past, or speeds up ads.
//
// Two ways to know an ad is playing:
//  - YouTube TV live: server.py holds the commercial breaks found by the
//    detector Chrome. We compare the player's own content timestamp (`ref`,
//    read by page-probe.js) with them. Everything fails toward NOT covering.
//  - Prime Video (and YouTube-inserted ads): the player shows an "Ad" label.
//  - Netflix: the player shows "Ad 1 of 5 · 2:01" (time left in the whole break),
//    which also drives the moon countdown.
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
    countdown: 'random',      // countdown scene: random each cover, or a SCENES name
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

  // Netflix's ad label (verified 2026-11-25, research/netflix/netflix-log.json):
  // [data-uia="ads-info-container"] holds "Ad", "1 of 5" and the time left in the
  // whole break ("2:01", or just "19" under a minute). It exists only during a
  // break (stays through every ad of it, removed at the end), so being in the
  // page is enough: it can be invisible for its first second or so (fading in).
  // No text scan on Netflix: a title starting with "Ad" must never cover.
  const NETFLIX_AD = '[data-uia="ads-info-container"]';
  const onNetflix = /(^|\.)netflix\.com$/.test(location.hostname);
  let nfTime = null;          // last timer text seen
  let nfTimeAt = 0;           // when it last changed (ms)

  function netflixAd() {
    const box = document.querySelector(NETFLIX_AD);
    if (!box || !box.textContent.trim()) { nfTime = null; return null; }
    const count = (box.querySelector('[data-uia="ads-info-count"]') || {}).textContent || '';
    const text = ((box.querySelector('[data-uia="ads-info-time"]') || {}).textContent || '').trim();
    const now = performance.now();
    if (text !== nfTime) { nfTime = text; nfTimeAt = now; }
    // The timer shows whole seconds, so count down between its changes, by at
    // most 1 s (it stops while the video is paused, and so does this).
    const m = text.match(/^(?:(\d+):)?(\d+)$/);
    const left = m ? Math.max(0, (+(m[1] || 0)) * 60 + (+m[2]) - Math.min((now - nfTimeAt) / 1000, 1)) : null;
    return { reason: `Netflix ad ${count.trim()}`.trim(), left };
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
      display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
      gap: 3vh; padding-top: 6vh; /* from the top, so trivia and the cards below have room */
      opacity: 0; transition: opacity 0.4s ease;
    }
    /* text appears once the curtain has (nearly) met in the middle */
    .scene.closed .content { opacity: 1; transition: opacity 1s ease var(--cdelay); }
    /* the countdown: one scene per cover (moon, ring, chicken, pool, diaper), see SCENES */
    .timer { display: flex; flex-direction: column; align-items: center; }
    .timer.row { flex-direction: row; gap: 3vmin; } /* picture scenes: the time beside them */
    .art { width: 22vmin; height: 22vmin; position: relative; }
    .art.wide { width: 56vmin; height: 28vmin; }
    .art svg {
      position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible;
      filter: drop-shadow(0 0 3vmin rgba(255, 233, 168, 0.25));
    }
    .breathe { animation: breathe 6s ease-in-out infinite; }
    .ctime {
      font-size: clamp(22px, 5vmin, 60px); font-weight: 700; color: #FFE9A8;
      font-variant-numeric: tabular-nums; min-height: 1.2em;
    }
    .cap { font-size: 9px; font-weight: 700; fill: #F7F3D6; text-anchor: middle; }
    .slide { transition: transform 0.3s linear; }
    /* ring: drains clockwise from 12 o'clock */
    .ring-track { fill: none; stroke: rgba(255, 233, 168, 0.12); stroke-width: 7; }
    .ring-arc { fill: none; stroke: #FFE9A8; stroke-width: 7; stroke-linecap: round;
                transition: stroke-dashoffset 0.3s linear; }
    /* chicken: walks (bob + legs) while counting, taps a foot while waiting */
    .bob { animation: bob 0.5s ease-in-out infinite; }
    .leg { transform-box: fill-box; transform-origin: 50% 0; }
    .walking .leg.a { animation: swing 0.5s ease-in-out infinite; }
    .walking .leg.b { animation: swing 0.5s ease-in-out infinite reverse; }
    .waiting .bob { animation: none; }
    .waiting .leg.a { animation: tap 0.8s ease-in-out infinite; }
    /* pool: the wave slides, drips fall while waiting, the duck bobs */
    .wave { animation: wave 2s linear infinite; }
    .wave.back { animation-duration: 3.2s; animation-direction: reverse; opacity: 0.55; }
    .drip { animation: drip 1.2s ease-in infinite; }
    .floaty { animation: floaty 2.4s ease-in-out infinite; }
    /* diaper change: legs kick, stink and powder puff, hearts float up */
    .kick { transform-box: fill-box; transform-origin: 0 50%; animation: kick 0.9s ease-in-out infinite; }
    .kick.b { animation-delay: -0.45s; }
    .stink { animation: rise 1.6s ease-out infinite; }
    .stink.b { animation-delay: -0.55s; } .stink.c { animation-delay: -1.1s; }
    .wipe { animation: wipe 0.6s ease-in-out infinite alternate; }
    .puff { transform-box: fill-box; transform-origin: center; animation: puff 1.2s ease-out infinite; }
    .heart { animation: rise 2s ease-out infinite; }
    .heart.b { animation-delay: -1s; }
    .tear { animation: drip 0.9s ease-in infinite; }
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
    @keyframes bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-1.5px); } }
    @keyframes swing { 0%, 100% { transform: rotate(-22deg); } 50% { transform: rotate(22deg); } }
    @keyframes tap { 0%, 60%, 100% { transform: rotate(0); } 30% { transform: rotate(-35deg); } }
    @keyframes wave { from { transform: translateX(0); } to { transform: translateX(-20px); } }
    @keyframes drip { from { transform: translateY(0); opacity: 1; } to { transform: translateY(var(--fall, 60px)); opacity: 0.2; } }
    @keyframes floaty { 0%, 100% { transform: translateY(0) rotate(-3deg); } 50% { transform: translateY(-1.5px) rotate(3deg); } }
    @keyframes kick { 0%, 100% { transform: rotate(-18deg); } 50% { transform: rotate(14deg); } }
    @keyframes rise { from { transform: translateY(0); opacity: 0.9; } to { transform: translateY(-14px); opacity: 0; } }
    @keyframes wipe { from { transform: translateX(-4px); } to { transform: translateX(4px); } }
    @keyframes puff { 0% { transform: scale(0.5); opacity: 1; } 60% { transform: scale(1.15); opacity: 0.9; }
                      100% { transform: scale(1.4); opacity: 0; } }
    @media (prefers-reduced-motion: reduce) {
      .art, .art * { animation: none !important; }
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

    const timer = document.createElement('div');
    timer.className = 'timer'; // filled by mountScene() at the start of each cover

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

    content.append(timer, msg, sub, trivia, recap);
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
    if (!host.parentNode) mountScene(pickScene()); // a new cover gets its own countdown scene
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

  // ---------- countdown scenes ----------
  // Each cover shows one scene, picked at random (never the same twice in a row)
  // unless the popup pins one. A scene's draw(m) runs every tick with
  //   m = null            no time (manual and label covers): a waiting loop
  //   m = {soon: true}    a break whose end isn't known yet: waiting, "Back soon"
  //   m = {left, frac}    counting: seconds left, fraction of the cover still to go
  // so the picture reaches its end (chicken home, pool full, clean diaper) as the
  // time runs out.

  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const waiting = (m) => !m || !!m.soon;
  const progress = (m) => (waiting(m) ? 0 : 1 - clamp01(m.frac)); // 0 at the start, 1 at the end
  const show = (el, on) => { el.style.display = on ? '' : 'none'; };

  function setText(el, s) { if (el.textContent !== s) el.textContent = s; }
  function g(attrs, ...kids) { const e = svgEl('g', attrs); e.append(...kids); return e; }
  function caption() { return svgEl('text', { class: 'cap', x: 100, y: 12 }); }

  // The moon: half lit with no time, full and "Back soon" while a break's end is
  // unknown, or waning with the time left as m:ss. Its time is drawn twice:
  // yellow over the dark part, and navy clipped to the lit part, so it reads at
  // every phase.
  function buildMoon(art) {
    const svg = svgEl('svg', { viewBox: '-50 -50 100 100' });
    const clip = svgEl('clipPath', { id: 'kas-lit' });
    clip.appendChild(svgEl('path', { class: 'lit-shape', transform: MOON_TILT }));
    // Spots fixed on the moon's face; the shadow passes over them.
    const craters = g({ class: 'craters', 'clip-path': 'url(#kas-lit)' });
    for (const [cx, cy, r] of CRATERS) craters.appendChild(svgEl('circle', { cx, cy, r }));
    svg.append(g({}, clip),
      svgEl('circle', { class: 'ghost', r: MOON_R }),
      svgEl('path', { class: 'lit lit-shape', transform: MOON_TILT }),
      craters,
      svgEl('text', { class: 'mtime on-dark' }),
      svgEl('text', { class: 'mtime on-lit', 'clip-path': 'url(#kas-lit)' }));
    art.appendChild(svg);
    return (m) => {
      art.classList.toggle('soon', !!m && !!m.soon);
      art.classList.toggle('breathe', waiting(m)); // holds still while counting so the numbers are steady
      const d = litPath(!m ? 0.5 : m.soon ? 1 : clamp01(m.frac));
      for (const p of art.querySelectorAll('.lit-shape')) {
        if (p.getAttribute('d') !== d) p.setAttribute('d', d);
      }
      const lines = !m ? [] : m.soon ? ['Back', 'soon'] : [mmss(m.left)];
      for (const t of art.querySelectorAll('.mtime')) setMoonText(t, lines);
    };
  }

  // A ring that drains clockwise from 12 o'clock around the time left.
  function buildRing(art) {
    const C = 2 * Math.PI * 42;
    const arc = svgEl('circle', { class: 'ring-arc', r: 42, transform: 'rotate(-90)', 'stroke-dasharray': `${C} ${C}` });
    const text = svgEl('text', { class: 'mtime on-dark' });
    const svg = svgEl('svg', { viewBox: '-50 -50 100 100' });
    svg.append(svgEl('circle', { class: 'ring-track', r: 42 }), arc, text);
    art.appendChild(svg);
    return (m) => {
      art.classList.toggle('soon', !!m && !!m.soon);
      art.classList.toggle('breathe', waiting(m));
      // A negative offset moves the arc's start along, so the gap grows from 12 o'clock.
      arc.style.strokeDashoffset = String(-C * (waiting(m) ? 0 : 1 - clamp01(m.frac)));
      setMoonText(text, !m ? [] : m.soon ? ['Back', 'soon'] : [mmss(m.left)]);
    };
  }

  // Why did the chicken cross the road? It walks from the left verge to its
  // coop on the far side; while waiting it taps a foot at the curb.
  function buildChicken(art) {
    art.classList.add('wide');
    const leg = (cls, x) => svgEl('line', { class: `leg ${cls}`, x1: x, y1: 8, x2: x * 1.3, y2: 16,
      stroke: '#F5A524', 'stroke-width': 1.8, 'stroke-linecap': 'round' });
    const bird = g({ class: 'bob' },
      svgEl('polygon', { points: '-11,-3 -18,-11 -15,1', fill: '#EDE3CC' }),          // tail
      svgEl('ellipse', { rx: 12, ry: 10, fill: '#FFF8E7' }),                           // body
      svgEl('ellipse', { cx: -2, cy: 1, rx: 7, ry: 4.5, fill: '#EDE3CC' }),            // wing
      svgEl('circle', { cx: 9, cy: -10, r: 6.5, fill: '#FFF8E7' }),                    // head
      svgEl('circle', { cx: 6.5, cy: -16.5, r: 2.4, fill: '#E5484D' }),                // comb
      svgEl('circle', { cx: 9.5, cy: -17.5, r: 2.4, fill: '#E5484D' }),
      svgEl('circle', { cx: 12.3, cy: -16, r: 2, fill: '#E5484D' }),
      svgEl('polygon', { points: '15,-11.5 20.5,-9.5 15,-7.5', fill: '#F5A524' }),     // beak
      svgEl('ellipse', { cx: 15, cy: -6, rx: 1.4, ry: 2.2, fill: '#E5484D' }),         // wattle
      svgEl('circle', { cx: 11, cy: -11.5, r: 1.2, fill: '#1B2552' }));                // eye
    const chicken = g({ class: 'slide' }, leg('a', -3), leg('b', 3), bird);
    chicken.style.transform = 'translate(30px, 62px)';
    const cap = caption();
    const svg = svgEl('svg', { viewBox: '0 0 200 100' });
    svg.append(
      svgEl('rect', { x: 0, y: 26, width: 66, height: 68, rx: 6, fill: '#2F5E46' }),   // near verge
      svgEl('rect', { x: 134, y: 26, width: 66, height: 68, rx: 6, fill: '#2F5E46' }), // far verge
      svgEl('rect', { x: 62, y: 26, width: 76, height: 68, fill: '#2B3150' }),         // road
      svgEl('line', { x1: 63, y1: 26, x2: 63, y2: 94, stroke: '#8D95B8', 'stroke-width': 1 }),
      svgEl('line', { x1: 137, y1: 26, x2: 137, y2: 94, stroke: '#8D95B8', 'stroke-width': 1 }),
      svgEl('line', { x1: 100, y1: 28, x2: 100, y2: 94, stroke: '#FFE9A8', 'stroke-width': 1.6, 'stroke-dasharray': '6 5' }),
      svgEl('circle', { cx: 14, cy: 86, r: 2, fill: '#FFE9A8' }),                      // flowers
      svgEl('circle', { cx: 44, cy: 34, r: 1.6, fill: '#F49AA8' }),
      svgEl('circle', { cx: 160, cy: 86, r: 1.8, fill: '#FFE9A8' }),
      g({ transform: 'translate(178 46)' },                                            // coop
        svgEl('rect', { x: -12, y: -6, width: 24, height: 20, rx: 1.5, fill: '#B5523B' }),
        svgEl('polygon', { points: '-15,-6 0,-18 15,-6', fill: '#7A2E22' }),
        svgEl('path', { d: 'M -4 14 V 6 A 4 4 0 0 1 4 6 V 14 Z', fill: '#2A1A1A' })),
      chicken, cap);
    art.appendChild(svg);
    return (m) => {
      const p = progress(m);
      chicken.style.transform = `translate(${30 + p * 122}px, 62px)`;
      svg.classList.toggle('waiting', waiting(m));
      svg.classList.toggle('walking', !waiting(m) && p < 1);
      setText(cap, !waiting(m) && p >= 0.9 ? 'To get to the other side!' : 'Why did the chicken cross the road?');
    };
  }

  // A pool fills from a tap while a rubber duck rides the water up. While
  // waiting the tap drips and the duck sits on the empty pool's floor.
  function buildPool(art) {
    art.classList.add('wide');
    const TOP = 40, BOTTOM = 88, L = 30, R = 170;
    // A wave 20 units long, repeated; sliding it by one wavelength loops seamlessly.
    const wave = (cls, amp) => {
      let d = `M ${L - 20} 0 Q ${L - 15} ${-amp} ${L - 10} 0`;
      for (let x = L; x <= R + 20; x += 10) d += ` T ${x} 0`;
      return svgEl('path', { class: cls, d: `${d} V ${BOTTOM - TOP + 4} H ${L - 20} Z`, fill: '#5BB8E8' });
    };
    const water = g({ class: 'slide' }, wave('wave back', 2), wave('wave', 1.5));
    const clip = svgEl('clipPath', { id: 'kas-pool' });
    clip.appendChild(svgEl('rect', { x: L, y: TOP, width: R - L, height: BOTTOM - TOP }));
    const stream = svgEl('rect', { x: 34.5, y: 26, width: 3, height: 0, fill: '#8FD3F5', opacity: 0.85 });
    const drip = svgEl('circle', { class: 'drip', cx: 36, cy: 28, r: 1.6, fill: '#8FD3F5' });
    drip.style.setProperty('--fall', `${BOTTOM - 30}px`);
    const duck = g({ class: 'slide' }, g({ class: 'floaty' },
      svgEl('polygon', { points: '-8,-2 -12,-7 -6,-4', fill: '#FFD43B' }),
      svgEl('ellipse', { rx: 9, ry: 6, fill: '#FFD43B' }),
      svgEl('ellipse', { cx: -1, cy: 0, rx: 4.5, ry: 3, fill: '#F2C12E' }),
      svgEl('circle', { cx: 6, cy: -7, r: 4.6, fill: '#FFD43B' }),
      svgEl('polygon', { points: '10,-7.5 14,-6.5 10,-5.5', fill: '#F5A524' }),
      svgEl('circle', { cx: 7.2, cy: -8.2, r: 0.9, fill: '#1B2552' })));
    duck.style.transform = `translate(118px, ${BOTTOM - 3}px)`;
    water.style.transform = `translate(0px, ${BOTTOM}px)`;
    const tiles = g({ stroke: 'rgba(159, 183, 230, 0.15)', 'stroke-width': 1 });
    for (let x = L + 20; x < R; x += 20) tiles.appendChild(svgEl('line', { x1: x, y1: TOP, x2: x, y2: BOTTOM }));
    const cap = caption();
    const svg = svgEl('svg', { viewBox: '0 0 200 100' });
    svg.append(g({}, clip),
      svgEl('rect', { x: L, y: TOP, width: R - L, height: BOTTOM - TOP, fill: '#1E2A5A' }),
      tiles,
      g({ 'clip-path': 'url(#kas-pool)' }, water),
      svgEl('rect', { x: L, y: TOP, width: R - L, height: BOTTOM - TOP, fill: 'none', stroke: '#9FB7E6', 'stroke-width': 2 }),
      svgEl('rect', { x: 8, y: 36, width: 22, height: 5, rx: 2, fill: '#C9BFA5' }),    // deck
      svgEl('rect', { x: 170, y: 36, width: 22, height: 5, rx: 2, fill: '#C9BFA5' }),
      g({ stroke: '#C9D3EE', 'stroke-width': 1.5, fill: 'none' },                    // ladder
        svgEl('path', { d: 'M 156 30 V 64 M 163 30 V 64 M 156 42 H 163 M 156 50 H 163 M 156 58 H 163' })),
      svgEl('path', { d: 'M 4 14 H 36 V 24', stroke: '#9AA3C7', 'stroke-width': 4, fill: 'none', 'stroke-linecap': 'round' }),
      svgEl('circle', { cx: 14, cy: 9, r: 3, fill: '#E5484D' }),                         // tap
      stream, drip, duck, cap);
    art.appendChild(svg);
    return (m) => {
      const p = progress(m);
      const top = BOTTOM - (BOTTOM - TOP) * p;
      water.style.transform = `translate(0px, ${top}px)`;
      duck.style.transform = `translate(118px, ${top - 3}px)`;
      stream.setAttribute('height', String(Math.max(0, top - 26)));
      show(stream, !waiting(m) && p < 1);
      show(drip, waiting(m));
      setText(cap, waiting(m) ? 'Drip, drip...' : p >= 0.85 ? 'Splash time!' : 'Filling the pool...');
    };
  }

  // A baby on a changing table: stinky diaper, wipes, powder puff, clean diaper,
  // a quarter of the time each. While waiting the baby just kicks, all clean.
  function buildDiaper(art) {
    art.classList.add('wide');
    const SKIN = '#F6C9A0', INK = '#5A3A2A';
    const line = (d) => svgEl('path', { d, stroke: INK, 'stroke-width': 1.2, fill: 'none', 'stroke-linecap': 'round' });
    const legAt = (cls, angle) => g({ transform: `translate(117 54) rotate(${angle})` }, g({ class: `kick ${cls}` },
      svgEl('rect', { x: 0, y: -2.8, width: 15, height: 5.6, rx: 2.8, fill: SKIN }),
      svgEl('circle', { cx: 15, cy: 0, r: 3.2, fill: SKIN })));
    const cry = g({},
      line('M 59 46.5 l 3 1.5 l -3 1.5'), line('M 69 46.5 l -3 1.5 l 3 1.5'),
      svgEl('ellipse', { cx: 64, cy: 55, rx: 3, ry: 2.6, fill: '#7A2E22' }),
      svgEl('circle', { class: 'tear', cx: 57, cy: 51, r: 1.2, fill: '#8FD3F5' }),
      svgEl('circle', { class: 'tear', cx: 71, cy: 51, r: 1.2, fill: '#8FD3F5' }));
    for (const t of cry.querySelectorAll('.tear')) t.style.setProperty('--fall', '8px');
    const calm = g({},
      svgEl('circle', { cx: 60, cy: 48, r: 1.3, fill: INK }), svgEl('circle', { cx: 68, cy: 48, r: 1.3, fill: INK }),
      line('M 62 54.5 q 2 1.2 4 0'));
    const happy = g({},
      line('M 58.5 48.5 q 1.5 -2.5 3 0'), line('M 66.5 48.5 q 1.5 -2.5 3 0'),
      svgEl('path', { d: 'M 60 53 q 4 5 8 0 Z', fill: '#7A2E22' }),
      svgEl('circle', { cx: 57.5, cy: 52.5, r: 1.8, fill: '#F49AA8', opacity: 0.7 }),
      svgEl('circle', { cx: 70.5, cy: 52.5, r: 1.8, fill: '#F49AA8', opacity: 0.7 }));
    const oldDiaper = svgEl('ellipse', { cx: 113, cy: 55, rx: 8, ry: 8, fill: '#D9C27A' });
    const newDiaper = g({}, svgEl('ellipse', { cx: 113, cy: 55, rx: 8, ry: 8, fill: '#FFFFFF' }),
      svgEl('rect', { x: 109, y: 48.5, width: 4, height: 3, rx: 1, fill: '#7FB3E6' }));
    const stinkLine = (cls, x) => svgEl('path', { class: `stink ${cls}`, d: `M ${x} 44 q -2 -3 0 -6 q 2 -3 0 -6`,
      stroke: '#8FD18A', 'stroke-width': 1.6, fill: 'none', 'stroke-linecap': 'round' });
    const stink = g({}, stinkLine('a', 106), stinkLine('b', 113), stinkLine('c', 120));
    const wipe = svgEl('rect', { class: 'wipe', x: 117, y: 47, width: 9, height: 7, rx: 1.5, fill: '#F7F3D6' });
    const puff = g({},
      g({ transform: 'rotate(35 125 33)' },                                              // powder bottle
        svgEl('rect', { x: 121.5, y: 28, width: 7, height: 11, rx: 2, fill: '#F7F3D6' }),
        svgEl('rect', { x: 122.5, y: 25.5, width: 5, height: 3, rx: 1, fill: '#7FB3E6' })),
      g({ class: 'puff' },
        svgEl('circle', { cx: 116, cy: 49, r: 4, fill: '#FFFFFF' }),
        svgEl('circle', { cx: 122, cy: 46, r: 3, fill: '#FFFFFF' }),
        svgEl('circle', { cx: 110, cy: 46, r: 3, fill: '#FFFFFF' })));
    const heart = (cls, x, y) => g({ transform: `translate(${x} ${y})` },
      svgEl('path', { class: `heart ${cls}`, d: 'M 0 4 C -6 0 -3 -5 0 -2 C 3 -5 6 0 0 4 Z', fill: '#E5484D' }));
    const hearts = g({}, heart('a', 88, 36), heart('b', 102, 32));
    const cap = caption();
    const svg = svgEl('svg', { viewBox: '0 0 200 100' });
    svg.append(
      svgEl('rect', { x: 44, y: 75, width: 5, height: 18, fill: '#A8743F' }),            // table
      svgEl('rect', { x: 151, y: 75, width: 5, height: 18, fill: '#A8743F' }),
      svgEl('rect', { x: 36, y: 69, width: 128, height: 6, rx: 2, fill: '#C98F5B' }),
      svgEl('rect', { x: 40, y: 62, width: 120, height: 7, rx: 3.5, fill: '#9EC9E8' }),
      legAt('a', -25), legAt('b', 5),
      svgEl('ellipse', { cx: 92, cy: 54, rx: 19, ry: 9, fill: '#FBE7A1' }),             // onesie
      svgEl('ellipse', { cx: 86, cy: 45, rx: 2.8, ry: 5.5, fill: SKIN, transform: 'rotate(-30 86 45)' }),
      svgEl('ellipse', { cx: 114, cy: 55, rx: 7, ry: 7, fill: SKIN }),                   // hips
      oldDiaper, newDiaper, wipe, puff, stink,
      svgEl('circle', { cx: 64, cy: 50, r: 11, fill: SKIN }),                            // head
      svgEl('path', { d: 'M 57 42 q 4 -6 9 -2', stroke: '#8A5A3C', 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round' }),
      cry, calm, happy, hearts, cap);
    art.appendChild(svg);
    const CAPS = ['Uh oh! Stinky diaper!', 'Wipe, wipe, wipe!', 'Powder puff!', 'All clean!'];
    return (m) => {
      const stage = waiting(m) ? -1 : Math.min(3, Math.floor(progress(m) * 4));
      show(oldDiaper, stage === 0); show(stink, stage === 0); show(cry, stage === 0);
      show(wipe, stage === 1); show(puff, stage === 2); show(calm, stage === 1 || stage === 2);
      const clean = stage === 3 || stage === -1;
      show(newDiaper, clean); show(happy, clean); show(hearts, stage === 3);
      setText(cap, stage < 0 ? 'Wiggle, wiggle!' : CAPS[stage]);
    };
  }

  const SCENES = { moon: buildMoon, ring: buildRing, chicken: buildChicken, pool: buildPool, diaper: buildDiaper };
  let sceneName = '';         // the countdown scene on the cover now (or last)
  let drawScene = null;       // its draw(m)

  function pickScene() {
    const names = Object.keys(SCENES);
    if (names.includes(settings.countdown)) return settings.countdown; // pinned in the popup
    const others = names.filter((n) => n !== sceneName);
    return others[Math.floor(Math.random() * others.length)];
  }

  function mountScene(name) {
    const timer = host.shadowRoot.querySelector('.timer');
    const art = document.createElement('div');
    art.className = 'art';
    timer.replaceChildren(art);
    const draw = SCENES[name](art);
    sceneName = name;
    // Moon and ring show their time inside; the picture scenes show it beside them.
    const time = document.createElement('div');
    time.className = 'ctime';
    const wide = art.classList.contains('wide');
    timer.classList.toggle('row', wide);
    if (wide) timer.appendChild(time);
    drawScene = (m) => {
      draw(m);
      setText(time, !m ? '' : m.soon ? 'Back soon' : mmss(m.left));
    };
    log('countdown scene:', name);
  }

  function setCountdown(m) {
    if (host && drawScene) drawScene(m);
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

  // The same for a labeled ad that shows its time left (Netflix).
  let labelStart = 0;         // when the current label cover began (ms), 0 = none
  let labelTotal = null;      // s from then to its end, once the time left is known

  function labelCountdown(left) {
    if (labelTotal == null) labelTotal = (performance.now() - labelStart) / 1000 + left;
    return { left, frac: labelTotal > 0 ? left / labelTotal : 0 };
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
        innerW: probe.innerW, innerH: probe.innerH,
        raw: probe.raw, path: location.pathname } }, () => {}); // raw + path: debug page only
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
        const nf = onNetflix ? netflixAd() : null;
        const label = onNetflix ? nf && nf.reason : detectAd();
        if (!label) labelDismissed = false;
        else if (!labelDismissed) {
          kind = 'label'; reason = label;
          if (!labelStart) labelStart = performance.now();
          if (nf && nf.left != null) {
            moon = labelCountdown(nf.left);
            planned = nf.left; // the curtain opens as the break's own timer runs out
          }
        }
      }
    } else {
      breakCoverId = null;
    }
    if (kind !== 'label') { labelStart = 0; labelTotal = null; }

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
      setCountdown(moon);
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
