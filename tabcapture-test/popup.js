// Throwaway: capture the active tab with chrome.tabCapture, draw frames to a
// canvas, and report whether they look like real video or all black.
const out = document.getElementById('out');
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

document.getElementById('go').onclick = () => {
  chrome.tabCapture.capture({ video: true, audio: false }, (stream) => {
    if (!stream) {
      out.textContent = 'FAILED: ' + (chrome.runtime.lastError?.message || 'no stream');
      return;
    }
    const v = document.createElement('video');
    v.srcObject = stream;
    v.muted = true;
    v.play();

    let n = 0;
    const tick = () => {
      if (v.videoWidth) {
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        // Mean brightness and standard deviation over the whole frame.
        let sum = 0, sum2 = 0, px = d.length / 4;
        for (let i = 0; i < d.length; i += 4) {
          const g = (d[i] + d[i + 1] + d[i + 2]) / 3;
          sum += g; sum2 += g * g;
        }
        const mean = sum / px;
        const sd = Math.sqrt(Math.max(0, sum2 / px - mean * mean));
        const verdict = sd < 2 ? 'BLACK/FLAT (likely DRM-blocked or nothing drawn)'
                               : 'REAL FRAMES (has picture detail)';
        out.textContent =
          `source ${v.videoWidth}x${v.videoHeight}   frames ${++n}\n` +
          `mean ${mean.toFixed(1)}   stddev ${sd.toFixed(1)}\n` +
          `=> ${verdict}\n\nAlso look at the canvas above. Report both to Claude.`;
      }
      setTimeout(tick, 500);
    };
    tick();
  });
};
