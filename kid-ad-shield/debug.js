// Shows what the detector sees: the cropped video, the corner it picked as the
// logo, the learned logo pixels (red) and the edges in the current frame (cyan).
const frame = document.getElementById('frame');
const corner = document.getElementById('corner');
const info = document.getElementById('info');
const fctx = frame.getContext('2d');
const cctx = corner.getContext('2d');

const hms = (s) => {
  if (s == null) return '-';
  const d = new Date(s * 1000);
  return d.toLocaleTimeString();
};

function draw(s) {
  const img = new Image();
  img.onload = () => {
    frame.width = s.cw; frame.height = s.ch;
    fctx.drawImage(img, 0, 0);
    if (s.corner) {
      const c = s.corner;
      fctx.strokeStyle = '#ffe9a8';
      fctx.strokeRect(c.x + 0.5, c.y + 0.5, c.w - 1, c.h - 1);
      corner.width = c.w; corner.height = c.h;
      cctx.drawImage(img, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
      const plot = (list, color) => {
        cctx.fillStyle = color;
        for (const i of list || []) cctx.fillRect(i % c.w, Math.floor(i / c.w), 1, 1);
      };
      plot(s.edges, 'rgba(94,224,255,0.9)');
      plot(s.mask, 'rgba(255,60,60,0.8)');
    }
  };
  img.src = s.frame;
}

async function tick() {
  let s;
  try { s = await chrome.runtime.sendMessage({ type: 'debug-snapshot' }); } catch (_) { s = null; }
  if (!s) { info.textContent = 'No detector running. In the detector Chrome, open the YouTube TV tab, set Mode = Reporter, press Start capture.'; return; }
  if (s.frame) draw(s);
  const lines = [
    `channel: ${s.channel || '-'}    logo state: ${s.logoState}${s.loading ? ' (loading)' : ''}`,
    s.learnProgress != null ? `learning: ${Math.round(s.learnProgress * 100)}% (needs about 90 s of normal play, no commercial)` : null,
    s.baseline != null ? `baseline ${s.baseline.toFixed(2)}   threshold ${s.thr.toFixed(2)}   score now ${s.score == null ? '-' : s.score.toFixed(2)}   ${s.present == null ? '' : (s.present ? 'LOGO PRESENT' : 'LOGO ABSENT')}` : null,
    s.logoState === 'ok' ? `in break: ${s.inBreak}   absent run ${s.absentRun}s (opens at 15)   present run ${s.presentRun}s (closes at 3)` : null,
    s.sizeMismatch ? 'WARNING: the picture shape changed since the logo was learned, so nothing is scored. Press Relearn.' : null,
    s.logoState === 'none' ? 'No stable logo found on this channel, so nothing is detected here. Try Relearn during normal play.' : null,
    s.geo ? `crop geometry: ${s.cw}x${s.ch} from stream ${s.geo.streamW}x${s.geo.streamH}; tab ${s.geo.innerW}x${s.geo.innerH} (scale ${s.geo.k.toFixed(2)}, offset ${Math.round(s.geo.ox)},${Math.round(s.geo.oy)}); element ${Math.round(s.geo.elem.w)}x${Math.round(s.geo.elem.h)}; video size reported by page: ${s.geo.vw}x${s.geo.vh}` : null,
    s.geo && !s.geo.hasAspect ? 'WARNING: the page probe is not reporting the video size, so black bars are NOT trimmed. Reload the YouTube TV tab (the page script is only updated on reload).' : null,
    s.geo && s.geo.hasAspect && Math.abs(s.cw / s.ch - s.geo.vw / s.geo.vh) > 0.05 ? 'WARNING: crop is not the video\'s shape; black bars may be inside the crop.' : null,
    '',
    'recent breaks (broadcast clock):',
    ...(s.history.length ? s.history.map((b) => `  ${hms(b.start_ref)} -> ${b.end_ref ? hms(b.end_ref) : '(open)'}`) : ['  none yet']),
  ].filter((l) => l !== null);
  info.textContent = lines.join('\n');
}

document.getElementById('relearn').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'relearn' }).catch(() => {}));
setInterval(tick, 700);
tick();
