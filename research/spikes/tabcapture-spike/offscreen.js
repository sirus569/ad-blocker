// Throwaway spike. Consumes the tab stream, samples a small frame twice a
// second, and reports brightness spread (sd), frame-to-frame change (motion),
// and how long the picture has been frozen (still, in samples).
const video = document.getElementById('v');
const ctx = document.getElementById('c').getContext('2d', { willReadFrequently: true });
const W = 160, H = 90;
const t0 = Date.now();
let stream = null, timer = null, n = 0, prev = null, still = 0, track = null;

const send = (m) => chrome.runtime.sendMessage(m).catch(() => {});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'start') start(msg.streamId);
});

async function start(streamId) {
  if (timer) clearInterval(timer);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  n = 0; prev = null; still = 0;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    });
  } catch (e) {
    return send({ type: 'event', text: `getUserMedia FAILED: ${e.message}` });
  }
  track = stream.getVideoTracks()[0];
  track.onended = () => send({ type: 'event', text: 'track ENDED' });
  track.onmute = () => send({ type: 'event', text: 'track muted (no frames)' });
  track.onunmute = () => send({ type: 'event', text: 'track unmuted' });
  video.srcObject = stream;
  video.play();
  timer = setInterval(tick, 500);
}

function tick() {
  if (!video.videoWidth) return;
  ctx.drawImage(video, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const g = new Float32Array(W * H);
  let sum = 0, sum2 = 0, diff = 0;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    g[p] = (d[i] + d[i + 1] + d[i + 2]) / 3;
    sum += g[p]; sum2 += g[p] * g[p];
    if (prev) diff += Math.abs(g[p] - prev[p]);
  }
  const px = W * H;
  const mean = sum / px;
  const sd = Math.sqrt(Math.max(0, sum2 / px - mean * mean));
  const motion = prev ? diff / px : 0;
  still = prev && motion < 0.05 ? still + 1 : 0;
  prev = g;
  send({
    type: 'stat', n: ++n, sd, motion, still,
    w: video.videoWidth, h: video.videoHeight,
    hidden: document.hidden, track: track.readyState,
    up: Math.round((Date.now() - t0) / 1000),
  });
}
