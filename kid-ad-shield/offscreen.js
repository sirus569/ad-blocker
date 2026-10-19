// Offscreen document for the detector Chrome.
//
// Consumes the tab-capture stream, crops the video out of the captured tab,
// learns where the channel's logo sits, and then watches for the logo to
// disappear. Breaks are sent to the server (via background.js), which logs them.
// Everything here fails toward NOT detecting: no logo learned = no breaks.
//
// Time base: every frame is tagged with `ref`, the content timestamp (Unix
// seconds) of what is on screen, computed from the page probe forwarded by
// content.js. The same timeline the TV Chrome uses.

// NOTE: offscreen documents only get chrome.runtime. No chrome.storage / tabs / action here;
// anything that needs them goes through background.js.
const video = document.getElementById('v');
const cv = document.createElement('canvas');
const ctx = cv.getContext('2d', { willReadFrequently: true });

// ---- tunables (SPEC 5.5) ----
const FRAME_MS = 250;          // 4 fps
const CROP_W = 480;            // video is downscaled to this width before any pixel work
const CORNER = 0.25;           // each corner region is 25% x 25% of the video
const LEARN_S = 90;            // content seconds of learning per channel
const MASK_FREQ = 0.85;        // a pixel is "logo" if it is an edge in this share of learning frames
const MIN_MASK = 60;           // fewer mask pixels than this = no usable logo
const EDGE_THR = 24;           // gradient (gray levels per pixel) that counts as an edge
const PRESENT_FRAC = 0.5;      // logo is "present" when score >= baseline * this
const ABSENT_S = 15;           // logo gone this long = a break opens
const PRESENT_S = 3;           // logo back this long = the break closes
const JUMP_S = 5;              // ref jumping more than this vs expected = seek/reload: reset
const GAP_S = 2;               // more missing seconds than this in a row: reset the segment
const BLANK_SD = 2;            // frames flatter than this are blank (e.g. mid-navigation): skipped
const INSET = 0.01;            // crop this much off each side of the picture (avoids border artifacts)
const EDGE_MARGIN = 3;         // logo pixels must be at least this far (crop px) from the picture's border

// ---- capture health ----
const FRAME_STALE_MS = 3000;   // no new frame for this long = capture not ok
const PROBE_STALE_MS = 2000;   // probe older than this = no reading
const STATE_EVERY_MS = 500;

let stream = null, track = null, gen = 0;
let lastFrameAt = 0;
let probe = null;              // latest probe from content.js (+ local receive time)
// Which "a frame arrived" signals fired (shown in the popup). Measured on the
// real detector Chrome: video.currentTime and getVideoPlaybackQuality() advance
// on the hidden capture video; requestVideoFrameCallback never fires there.
const diag = { ct: 0, tvf: 0 };
let lastCt = -1, lastTvf = -1;

// ---- detector state ----
let channel = '';
let logoState = 'none';        // 'learning' | 'ok' | 'none'  (none = do not detect)
let logo = null;               // {corner, w, h, cropW, cropH, mask:[idx], baseline}
let learn = null;              // {counts:[Uint16Array x4], n, startRef, w, h, cropW, cropH}
let loading = false;           // stored logo being looked up
let lastRef = null, lastWall = null, lastSec = null;
let bucket = [];               // scores seen in the current 1 s bucket
let absentRun = 0, absentStart = 0, presentRun = 0, presentStart = 0;
let cur = null;                // the open break {key, channel, start_ref}
let breakN = 0;
const history = [];            // recent breaks for the debug page
const traceRows = [];
let traceThr = 0, traceBase = 0;
let lastScore = null, lastPresent = null;
let lastSnap = null;           // for the debug page: current corner edges
let sizeMismatch = false;      // crop size differs from the one the logo was learned on
let geo = null;                // what the last crop was computed from (for the debug page)

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'capture-start') start(msg.streamId);
  else if (msg.type === 'probe') probe = { ...msg.probe, recv: performance.now() };
  else if (msg.type === 'relearn') relearn();
  else if (msg.type === 'program') program = msg.name || '';
  else if (msg.type === 'debug-snapshot') { sendResponse(snapshot()); return false; }
  return false;
});

async function start(streamId) {
  stop();
  const my = ++gen;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    });
  } catch (e) {
    console.warn('[Kid Ad Shield] capture failed:', e.message);
    return;
  }
  if (my !== gen) { stream.getTracks().forEach((t) => t.stop()); return; }
  track = stream.getVideoTracks()[0];
  track.onended = () => {
    console.log('[Kid Ad Shield] capture track ended');
    chrome.runtime.sendMessage({ type: 'capture-ended' }).catch(() => {});
  };
  video.srcObject = stream;
  try { await video.play(); } catch (_) { /* muted autoplay should work */ }
}

function stop() {
  gen += 1;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  track = null;
  video.srcObject = null;
  lastFrameAt = 0;
}

function pollFrameSignals() {
  const now = performance.now();
  if (video.currentTime !== lastCt) {
    if (lastCt >= 0) { diag.ct += 1; lastFrameAt = Math.max(lastFrameAt, now); }
    lastCt = video.currentTime;
  }
  const q = video.getVideoPlaybackQuality && video.getVideoPlaybackQuality();
  if (q && q.totalVideoFrames !== lastTvf) {
    if (lastTvf >= 0) { diag.tvf += 1; lastFrameAt = Math.max(lastFrameAt, now); }
    lastTvf = q.totalVideoFrames;
  }
}

function report() {
  pollFrameSignals();
  const now = performance.now();
  // The video element keeps showing the last frame after the track ends, so
  // never trust the picture: the track itself must be live.
  const live = !!track && track.readyState === 'live';
  const framesOk = live && lastFrameAt > 0 && now - lastFrameAt < FRAME_STALE_MS;
  const probeOk = !!probe && probe.ref != null && now - probe.recv < PROBE_STALE_MS;
  chrome.runtime.sendMessage({
    type: 'capture-state',
    ok: framesOk && probeOk,
    logo: logoState,
    w: video.videoWidth, h: video.videoHeight,
    diag: { ...diag, live, frameAgeMs: lastFrameAt ? Math.round(now - lastFrameAt) : null, probeOk },
  }).catch(() => {});
}

// ---------- image helpers ----------

// Binary edge map (1 = edge) of a gray image region. Border pixels stay 0.
function edgeMap(g, w, h) {
  const e = new Uint8Array(w * h);
  const lim = (4 * EDGE_THR) ** 2; // Sobel responds with 4x the step height
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -g[i - w - 1] + g[i - w + 1] - 2 * g[i - 1] + 2 * g[i + 1] - g[i + w - 1] + g[i + w + 1];
      const gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
      if (gx * gx + gy * gy > lim) e[i] = 1;
    }
  }
  return e;
}

function cornerRect(c, cw, ch) {
  const w = Math.round(cw * CORNER), h = Math.round(ch * CORNER);
  return { x: c & 1 ? cw - w : 0, y: c & 2 ? ch - h : 0, w, h }; // 0 TL, 1 TR, 2 BL, 3 BR
}

function grayRegion(rgba, cw, r) {
  const g = new Float32Array(r.w * r.h);
  for (let y = 0; y < r.h; y++) {
    let p = ((r.y + y) * cw + r.x) * 4;
    for (let x = 0; x < r.w; x++, p += 4) g[y * r.w + x] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  return g;
}

// Brightness spread over the whole crop (sampled); ~0 means a blank frame.
function frameSd(rgba) {
  let n = 0, s = 0, s2 = 0;
  for (let p = 0; p < rgba.length; p += 28) {
    const v = (rgba[p] + rgba[p + 1] + rgba[p + 2]) / 3;
    n++; s += v; s2 += v * v;
  }
  const m = s / n;
  return Math.sqrt(Math.max(0, s2 / n - m * m));
}

// ---------- logo learning ----------

// Logos are saved as templates on server.py, one per PROGRAM (e.g. "NBC SNF"):
// the same channel shows different logos for different programs, and a program's
// logo is the same week to week. With no program chosen, the template is per channel.
let program = '';              // chosen in the popup
let templateName = '';         // template currently loaded / being learned

const wantedTemplate = () => (program ? program : `channel ${channel}`);

chrome.runtime.sendMessage({ type: 'get-program' })
  .then((r) => { if (r && r.ok) program = r.program || ''; })
  .catch(() => {});

function setChannel(ch) {
  endSegment('channel change');
  channel = ch;
}

// Load the template for `name` from the server. While loading (or if the server
// can't be asked) nothing is learned or detected: learning while the server is
// unreachable could overwrite a good template later.
async function loadTemplate(name) {
  endSegment('template change');
  templateName = name;
  logo = null; learn = null; logoState = 'learning'; loading = true;
  let r = null;
  try { r = await chrome.runtime.sendMessage({ type: 'template-get', name }); } catch (_) { /* below */ }
  if (templateName !== name) return;
  if (!r || !r.ok) {
    logoState = 'none';
    console.log('[Kid Ad Shield] could not ask the server for template', name, '- retrying');
    setTimeout(() => { if (templateName === name && loading) loadTemplate(name); }, 5000);
    return;
  }
  loading = false;
  if (r.template) {
    logo = r.template;
    logoState = 'ok';
    traceThr = logo.baseline * PRESENT_FRAC; traceBase = logo.baseline;
    console.log('[Kid Ad Shield] loaded template', name);
  } else {
    console.log('[Kid Ad Shield] no template for', name, '- learning');
  }
}

function relearn() {
  if (!templateName) return;
  chrome.runtime.sendMessage({ type: 'template-delete', name: templateName }).catch(() => {});
  endSegment('relearn');
  logo = null; learn = null; logoState = 'learning';
  console.log('[Kid Ad Shield] relearning template', templateName);
}

function learnFrame(rgba, cw, ch, refAt) {
  if (learn && (learn.cropW !== cw || learn.cropH !== ch)) learn = null; // window resized: restart
  if (!learn) {
    const r = cornerRect(0, cw, ch);
    learn = { counts: [0, 1, 2, 3].map(() => new Uint16Array(r.w * r.h)), n: 0, startRef: refAt, w: r.w, h: r.h, cropW: cw, cropH: ch };
  }
  for (let c = 0; c < 4; c++) {
    const r = cornerRect(c, cw, ch);
    const e = edgeMap(grayRegion(rgba, cw, r), r.w, r.h);
    const counts = learn.counts[c];
    for (let i = 0; i < e.length; i++) counts[i] += e[i];
  }
  learn.n += 1;
  if (refAt - learn.startRef >= LEARN_S && learn.n >= 100) finishLearning();
}

function finishLearning() {
  let best = null;
  for (let c = 0; c < 4; c++) {
    const mask = [];
    let sum = 0;
    const counts = learn.counts[c];
    const r = cornerRect(c, learn.cropW, learn.cropH);
    for (let i = 0; i < counts.length; i++) {
      // A line hugging the picture's border (frame edge, bar bleed, UI) is stable but is not a logo.
      const cx = r.x + (i % r.w), cy = r.y + Math.floor(i / r.w);
      if (cx < EDGE_MARGIN || cy < EDGE_MARGIN || cx >= learn.cropW - EDGE_MARGIN || cy >= learn.cropH - EDGE_MARGIN) continue;
      const f = counts[i] / learn.n;
      if (f >= MASK_FREQ) { mask.push(i); sum += f; }
    }
    if (mask.length >= MIN_MASK && (!best || mask.length > best.mask.length)) {
      best = { corner: c, mask, baseline: sum / mask.length };
    }
  }
  if (!best) {
    logoState = 'none';
    console.log('[Kid Ad Shield] no stable logo found for', channel, '(not detecting on this channel)');
  } else {
    logo = { corner: best.corner, w: learn.w, h: learn.h, cropW: learn.cropW, cropH: learn.cropH,
             mask: best.mask, baseline: best.baseline };
    logoState = 'ok';
    traceThr = logo.baseline * PRESENT_FRAC; traceBase = logo.baseline;
    chrome.runtime.sendMessage({ type: 'template-set', name: templateName, template: logo }).catch(() => {});
    console.log('[Kid Ad Shield] learned template', templateName, 'corner', best.corner,
      'pixels', best.mask.length, 'baseline', best.baseline.toFixed(2));
  }
  learn = null;
}

// ---------- per-frame work ----------

function processFrame() {
  const now = performance.now();
  if (!track || track.readyState !== 'live' || !video.videoWidth) return;
  if (!probe || probe.ref == null || now - probe.recv > PROBE_STALE_MS || !probe.rect || !probe.innerW) return;
  if (probe.paused) { lastRef = lastWall = null; return; } // frozen picture proves nothing
  if (probe.channel && probe.channel !== channel) { setChannel(probe.channel); return; }
  if (!channel) return;
  if (wantedTemplate() !== templateName) { loadTemplate(wantedTemplate()); return; }
  if (loading) return;

  const wall = Date.now() / 1000;
  const refAt = probe.ref + (wall - probe.wall);
  if (lastRef != null && Math.abs(refAt - (lastRef + (wall - lastWall))) > JUMP_S) endSegment('ref jump');
  lastRef = refAt; lastWall = wall;

  // Crop the video out of the captured tab (probe.rect is in page pixels).
  // The <video> element can be bigger than the picture (black bars when the window
  // is not 16:9), so find the picture itself: the element's box with the video's own
  // aspect ratio, centered (object-fit: contain). Corners must be the PICTURE's corners.
  let rx = probe.rect.x, ry = probe.rect.y, rw = probe.rect.w, rh = probe.rect.h;
  if (probe.vw > 0 && probe.vh > 0) {
    const k = Math.min(rw / probe.vw, rh / probe.vh);
    const pw = probe.vw * k, ph = probe.vh * k;
    rx += (rw - pw) / 2; ry += (rh - ph) / 2; rw = pw; rh = ph;
  }
  const hasAspect = probe.vw > 0 && probe.vh > 0;
  rx += rw * INSET; ry += rh * INSET; rw *= 1 - 2 * INSET; rh *= 1 - 2 * INSET;
  // Page pixels -> stream pixels. The capture stream is not always the tab's shape:
  // Chrome fits the tab inside it, centered, and fills the rest with black (seen on
  // the real setup: a 3440x1440 stream for a ~16:9 tab). So scale uniformly and offset.
  const k = Math.min(video.videoWidth / probe.innerW, video.videoHeight / probe.innerH);
  const ox = (video.videoWidth - probe.innerW * k) / 2, oy = (video.videoHeight - probe.innerH * k) / 2;
  const x = Math.max(0, ox + rx * k), y = Math.max(0, oy + ry * k);
  const w = Math.min(video.videoWidth - x, rw * k), h = Math.min(video.videoHeight - y, rh * k);
  if (w < 160 || h < 90) return;
  geo = { elem: probe.rect, vw: probe.vw, vh: probe.vh, hasAspect, innerW: probe.innerW, innerH: probe.innerH,
          streamW: video.videoWidth, streamH: video.videoHeight, k, ox, oy, src: { x, y, w, h } };
  const cw = CROP_W, ch = Math.round(CROP_W * h / w);
  if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
  ctx.drawImage(video, x, y, w, h, 0, 0, cw, ch);
  const rgba = ctx.getImageData(0, 0, cw, ch).data;
  if (frameSd(rgba) < BLANK_SD) return; // blank frame: neither present nor absent

  if (logoState === 'learning') { learnFrame(rgba, cw, ch, refAt); lastSnap = { edges: [] }; return; }
  if (logoState !== 'ok' || !logo) return;
  sizeMismatch = logo.cropW !== cw || logo.cropH !== ch;
  if (sizeMismatch) return; // picture shape changed since learning: needs Relearn

  const r = cornerRect(logo.corner, cw, ch);
  const e = edgeMap(grayRegion(rgba, cw, r), r.w, r.h);
  let hits = 0;
  for (const i of logo.mask) hits += e[i];
  const score = hits / logo.mask.length;
  const thr = logo.baseline * PRESENT_FRAC;
  lastScore = score; lastPresent = score >= thr;
  lastSnap = { edges: edgeList(e) };

  addScore(refAt, score, thr);
}

function edgeList(e) {
  const out = [];
  for (let i = 0; i < e.length; i++) if (e[i]) out.push(i);
  return out;
}

// ---------- 1 s buckets and break segmentation (hindsight) ----------

function addScore(refAt, score, thr) {
  const sec = Math.floor(refAt);
  if (lastSec !== null && sec < lastSec) endSegment('ref went backwards');
  if (lastSec === null) lastSec = sec;
  if (sec !== lastSec) {
    finishSecond(lastSec, median(bucket), thr);
    if (sec - lastSec - 1 > GAP_S) endSegment('gap in frames');
    bucket = [];
    lastSec = sec;
  }
  bucket.push(score);
}

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((p, q) => p - q);
  return s[Math.floor(s.length / 2)];
}

function finishSecond(sec, score, thr) {
  const present = score >= thr;
  traceRows.push([sec, +score.toFixed(3), present ? 1 : 0]);
  if (!cur) {
    if (!present) {
      if (absentRun === 0) absentStart = sec;
      absentRun += 1;
      if (absentRun >= ABSENT_S) openBreak(absentStart);
    } else {
      absentRun = 0;
    }
  } else if (present) {
    if (presentRun === 0) presentStart = sec;
    presentRun += 1;
    if (presentRun >= PRESENT_S) closeBreak(presentStart);
  } else {
    presentRun = 0;
  }
}

function openBreak(startRef) {
  breakN += 1;
  cur = { key: `${Date.now().toString(36)}-${breakN}`, channel, start_ref: startRef, end_ref: null };
  presentRun = 0;
  history.push(cur);
  if (history.length > 10) history.shift();
  console.log('[Kid Ad Shield] break OPEN at ref', startRef);
  sendBreak(cur);
}

function closeBreak(endRef) {
  if (!cur) return;
  cur.end_ref = Math.max(endRef, cur.start_ref + 1);
  console.log('[Kid Ad Shield] break CLOSE at ref', cur.end_ref);
  sendBreak(cur);
  cur = null;
  absentRun = 0; presentRun = 0;
}

// Forget in-progress work after something that makes the timeline unreliable.
// An open break is closed where we last saw the content, so it can't hang open.
function endSegment(why) {
  if (cur && lastSec != null) closeBreak(lastSec + 1);
  else cur = null;
  absentRun = 0; presentRun = 0; bucket = [];
  lastSec = null; lastRef = lastWall = null;
  if (why) console.log('[Kid Ad Shield] segment reset:', why);
}

// Send a break to the server (open, then again with end_ref when it closes).
// Retried a few times so a brief server hiccup doesn't lose it from the log.
function sendBreak(b, attempt = 0) {
  const retry = () => { if (attempt < 5) setTimeout(() => sendBreak(b, attempt + 1), 2000); };
  chrome.runtime.sendMessage({ type: 'break', key: b.key, channel: b.channel,
    start_ref: b.start_ref, end_ref: b.end_ref })
    .then((r) => { if (!r || !r.ok) retry(); })
    .catch(retry);
}

// Per-second scores for reviewing detection quality later.
function flushTrace() {
  if (!traceRows.length || !channel) return;
  const rows = traceRows.splice(0, traceRows.length);
  chrome.runtime.sendMessage({ type: 'trace', channel, thr: +traceThr.toFixed(3),
    baseline: +traceBase.toFixed(3), rows }).catch(() => {});
}

// ---------- debug page ----------

function snapshot() {
  const out = {
    channel, program, templateName, logoState, loading, score: lastScore, present: lastPresent,
    thr: logo ? logo.baseline * PRESENT_FRAC : null, baseline: logo ? logo.baseline : null,
    inBreak: !!cur, absentRun, presentRun, history, lastRef,
    sizeMismatch, geo,
    learnProgress: logoState === 'learning' && learn && lastRef ? Math.max(0, Math.min(1, (lastRef - learn.startRef) / LEARN_S)) : null,
    cw: cv.width, ch: cv.height,
  };
  if (cv.width > 0) {
    out.frame = cv.toDataURL('image/jpeg', 0.7);
    out.corner = logo ? cornerRect(logo.corner, cv.width, cv.height) : null;
    out.mask = logo ? logo.mask : null;
    out.edges = lastSnap ? lastSnap.edges : [];
  }
  return out;
}

setInterval(processFrame, FRAME_MS);
setInterval(report, STATE_EVERY_MS);
setInterval(flushTrace, 5000);
