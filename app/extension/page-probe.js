// Kid Ad Shield: page probe (runs in the page's own JavaScript world).
//
// YouTube's player API is attached to the player element by YouTube's own page
// script, so the extension's normal (isolated) content script cannot see it.
// This script reads it and hands the numbers to content.js through an event.
//
// READ ONLY. It never calls seek methods and never modifies the page or video.
(() => {
  'use strict';
  if (window.__kasProbe) return;
  window.__kasProbe = true;

  const EVERY_MS = 250;

  function findPlayer() {
    return document.querySelector('.html5-video-player') || document.querySelector('#movie_player');
  }

  // The main video: has data, and is the largest one on screen.
  function findVideo() {
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      if (v.readyState <= 2) continue;
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  function read() {
    const out = { ref: null, at_live: null, paused: null, rect: null,
                  innerW: window.innerWidth, innerH: window.innerHeight,
                  wall: Date.now() / 1000 };
    try {
      const player = findPlayer();
      const video = findVideo();
      if (video) {
        const r = video.getBoundingClientRect();
        out.paused = video.paused;
        out.vw = video.videoWidth;   // the picture's own size, to find it inside the element
        out.vh = video.videoHeight;
        out.rect = { x: r.x, y: r.y, w: r.width, h: r.height };
      }
      if (player && typeof player.getMediaReferenceTime === 'function') {
        const ref = player.getMediaReferenceTime();
        // Unix seconds; anything else (0, NaN, tiny numbers) means "not ready".
        if (typeof ref === 'number' && Number.isFinite(ref) && ref > 1e9) out.ref = ref;
        if (typeof player.isAtLiveHead === 'function') out.at_live = !!player.isAtLiveHead();
      }
    } catch (_) {
      out.ref = null; // any failure means "no reading"
    }
    return out;
  }

  // JSON string so the detail crosses into the isolated world safely.
  setInterval(() => {
    window.dispatchEvent(new CustomEvent('kas-probe', { detail: JSON.stringify(read()) }));
  }, EVERY_MS);
})();
