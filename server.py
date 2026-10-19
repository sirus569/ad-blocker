#!/usr/bin/env python3
"""Kid Ad Shield server (SPEC.md section 5.2).

Stores the breaks the detector Chrome reports and tells the TV Chrome which
ones apply. Local only (127.0.0.1). Stop it (Ctrl+C) and the TV uncovers.
Python standard library only.

  python3 server.py [--log-only] [--program-start HH:MM[:SS]] [--fake-break START END CHANNEL]

Every break the detector finds is also written to logs/breaks-<session>.log
(and a per-second score trace to logs/trace-<session>.csv) so detection quality
can be reviewed later against a recording.
"""
import argparse
import atexit
import json
import math
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HOST, PORT = '127.0.0.1', 8787
HERE = os.path.dirname(os.path.abspath(__file__))
BREAKS_FILE = os.path.join(HERE, 'breaks.json')
CONFIG_FILE = os.path.join(HERE, 'config.json')   # optional: {"offset_s": {"<channel>": 0.0}}
LOGS_DIR = os.path.join(HERE, 'logs')

ALIVE_S = 10          # detector report this recent counts as alive (/tv/sync)
HEARTBEAT_S = 3       # status line marks a part x when older than this
KEEP_S = 6 * 3600     # drop breaks starting more than this far behind the newest ref
OPEN_MAX_S = 240      # discard an open break once the detector is this far past its start
SYNC_WINDOW_S = 60    # /tv/sync leaves out breaks that ended this long before the TV's ref
STATUS_EVERY_S = 5
MAX_BODY = 64 * 1024


def fnum(x):
    """float(x) if it is a finite number, else None."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def clock(ref):
    return datetime.fromtimestamp(ref).strftime('%H:%M:%S')


def hms(sec):
    """Seconds -> H:MM:SS (e.g. 3903 -> 1:05:03)."""
    sign = '-' if sec < 0 else ''
    sec = int(round(abs(sec)))
    return f'{sign}{sec // 3600}:{sec % 3600 // 60:02d}:{sec % 60:02d}'


class State:
    def __init__(self, log_only):
        self.lock = threading.Lock()
        self.log_only = log_only
        self.det = {}        # latest detector report + 'recv' (server time received)
        self.tv = {}         # latest TV sync params + 'recv'
        self.breaks = {}     # key -> break dict
        self.next_id = 1
        self.pending_fake = []   # (start, end, channel) where start/end may be '+N' strings
        self.offsets = {}
        self.origins = {}          # channel -> ref that counts as program time 0:00:00
        self.program_start_sod = None   # --program-start as seconds since local midnight
        stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        self.break_log = os.path.join(LOGS_DIR, f'breaks-{stamp}.log')
        self.trace_log = os.path.join(LOGS_DIR, f'trace-{stamp}.csv')
        self.trace_meta = None
        self.load()

    # ---- persistence ----
    def load(self):
        try:
            with open(CONFIG_FILE) as f:
                self.offsets = {k: float(v) for k, v in json.load(f).get('offset_s', {}).items()}
        except (OSError, ValueError):
            pass
        try:
            with open(BREAKS_FILE) as f:
                items = json.load(f)
        except (OSError, ValueError):
            return
        cutoff = time.time() - KEEP_S
        for b in items:
            if b['start_ref'] >= cutoff:
                b['id'] = self.next_id
                self.next_id += 1
                self.breaks[b['key']] = b

    def save(self):
        real = [b for b in self.breaks.values() if not b.get('fake')]
        tmp = BREAKS_FILE + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(real, f)
        os.replace(tmp, BREAKS_FILE)

    # ---- review logs (call with lock held) ----
    def origin(self, channel, ref):
        """Program time 0:00:00: --program-start if given, else the first ref this
        session saw on the channel."""
        if self.program_start_sod is not None:
            base = datetime.fromtimestamp(ref).replace(hour=0, minute=0, second=0, microsecond=0)
            o = base.timestamp() + self.program_start_sod
            return o - 86400 if o > ref else o
        return self.origins.setdefault(channel, ref)

    def append(self, path, text):
        os.makedirs(LOGS_DIR, exist_ok=True)
        with open(path, 'a') as f:
            f.write(text)

    def log_break(self, b, closed):
        """One line when a break opens, one when it closes. Times are program time
        (H:MM:SS since the origin) plus the broadcast clock time of the content."""
        o = self.origin(b['channel'], b['start_ref'])
        stamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        start = hms(b['start_ref'] - o)
        if not closed:
            line = (f"{stamp}  ch={b['channel']}  break {b['id']}  started -> {start}"
                    f"  (broadcast clock {clock(b['start_ref'])})\n")
        else:
            line = (f"{stamp}  ch={b['channel']}  break {b['id']}  started -> {start}, "
                    f"ended -> {hms(b['end_ref'] - o)}  (length {hms(b['end_ref'] - b['start_ref'])}, "
                    f"broadcast clock {clock(b['start_ref'])} - {clock(b['end_ref'])})\n")
        self.append(self.break_log, line)

    def trace(self, d):
        """Per-second logo scores from the detector: [ref, score, present] rows."""
        ch, rows = d.get('channel'), d.get('rows')
        if not (isinstance(ch, str) and isinstance(rows, list)):
            return {'ok': False, 'error': 'channel and rows required'}
        out = ''
        with self.lock:
            meta = (ch, d.get('thr'), d.get('baseline'))
            if meta != self.trace_meta:
                self.trace_meta = meta
                out += f"# channel={ch} threshold={d.get('thr')} baseline={d.get('baseline')}\n"
                if not os.path.exists(self.trace_log):
                    out = 'program_time,broadcast_clock,ref,score,present\n' + out
            for r in rows[:500]:
                ref, score, present = fnum(r[0]), fnum(r[1]), r[2]
                if ref is None or score is None:
                    continue
                o = self.origin(ch, ref)
                out += f"{hms(ref - o)},{clock(ref)},{ref:.0f},{score:.3f},{int(bool(present))}\n"
            if out:
                self.append(self.trace_log, out)
        return {'ok': True}

    # ---- helpers (call with lock held) ----
    def now_ref(self, part, now):
        """Estimate a part's current ref from its last report."""
        if not part or part.get('ref') is None:
            return None
        return part['ref'] if part.get('paused') else part['ref'] + (now - part['recv'])

    def maintain(self, now):
        """Drop stale or stuck breaks. Returns True if anything changed."""
        newest = self.now_ref(self.det, now) or now
        changed = False
        for key, b in list(self.breaks.items()):
            old = b['start_ref'] < newest - KEEP_S
            stuck = (b['end_ref'] is None and not b.get('fake')
                     and self.det.get('channel') == b['channel']
                     and (self.now_ref(self.det, now) or 0) > b['start_ref'] + OPEN_MAX_S)
            if old or stuck:
                del self.breaks[key]
                changed = True
                if stuck:
                    print(f"[break] discarded stuck open break {b['id']} ch={b['channel']}")
        return changed

    def resolve_fakes(self, channel, ref):
        """Turn '+N' fake breaks into absolute ones once the TV's ref is known."""
        if not self.pending_fake or ref is None:
            return
        for s, e, ch in self.pending_fake:
            start = ref + float(s[1:]) if str(s).startswith('+') else float(s)
            end = None if str(e).lower() == 'open' else (
                ref + float(e[1:]) if str(e).startswith('+') else float(e))
            ch = channel if ch == 'tv' else ch
            key = f'fake-{self.next_id}'
            self.breaks[key] = {'id': self.next_id, 'key': key, 'channel': ch,
                                'start_ref': start, 'end_ref': end,
                                'confirmed_at': time.time(), 'fake': True}
            self.next_id += 1
            print(f"[fake] break ch={ch} {clock(start)} -> {clock(end) if end else 'open'}")
        self.pending_fake = []

    # ---- endpoints ----
    def detector_report(self, d):
        ch, now = d.get('channel'), time.time()
        if not isinstance(ch, str) or not ch:
            return {'ok': False, 'error': 'channel required'}
        with self.lock:
            self.det = {'channel': ch, 'ref': fnum(d.get('ref')), 'at_live': bool(d.get('at_live')),
                        'paused': bool(d.get('paused')), 'capture_ok': bool(d.get('capture_ok')),
                        'logo': str(d.get('logo', '?')), 'recv': now}
            if self.det['ref'] is not None and self.program_start_sod is None:
                self.origins.setdefault(ch, self.det['ref'])
            if self.maintain(now):
                self.save()
            follow = None
            tv_ch = self.tv.get('channel')
            if tv_ch and now - self.tv['recv'] <= ALIVE_S and tv_ch != ch:
                follow = tv_ch
        return {'ok': True, 'follow_channel': follow}

    def detector_break(self, d):
        key, ch = d.get('key'), d.get('channel')
        start, end = fnum(d.get('start_ref')), d.get('end_ref')
        end = None if end is None else fnum(end)
        if not (isinstance(key, str) and key and isinstance(ch, str) and ch and start is not None):
            return {'ok': False, 'error': 'key, channel, start_ref required'}
        if d.get('end_ref') is not None and (end is None or end <= start):
            return {'ok': False, 'error': 'end_ref must be a number after start_ref'}
        with self.lock:
            b = self.breaks.get(key)
            new = b is None
            if new:
                b = {'id': self.next_id, 'key': key, 'fake': False}
                self.next_id += 1
                self.breaks[key] = b
            was_open = new or b['end_ref'] is None
            b.update(channel=ch, start_ref=start, end_ref=end, confirmed_at=time.time())
            self.save()
            if new and end is None:
                print(f"[break] OPEN  id={b['id']} ch={ch} start {clock(start)} (ref {start:.1f})")
                if not b.get('fake'):
                    self.log_break(b, closed=False)
            elif end is not None and was_open:
                print(f"[break] CLOSE id={b['id']} ch={ch} {clock(start)} -> {clock(end)} "
                      f"({end - start:.0f}s)")
                if not b.get('fake'):
                    self.log_break(b, closed=True)
            return {'ok': True, 'id': b['id']}

    def tv_sync(self, q):
        now = time.time()
        ch = q.get('channel', [''])[0]
        ref = fnum(q.get('ref', [None])[0])
        with self.lock:
            self.tv = {'channel': ch, 'ref': ref, 'at_live': q.get('at_live', ['0'])[0] == '1',
                       'paused': q.get('paused', ['0'])[0] == '1', 'recv': now}
            self.resolve_fakes(ch, ref)
            if self.maintain(now):
                self.save()
            alive = (bool(self.det) and now - self.det['recv'] <= ALIVE_S
                     and self.det['capture_ok'] and self.det['channel'] == ch)
            out = []
            if not self.log_only:
                off = self.offsets.get(ch, 0.0)
                for b in sorted(self.breaks.values(), key=lambda x: x['start_ref']):
                    if b['channel'] != ch:
                        continue
                    end = None if b['end_ref'] is None else b['end_ref'] + off
                    if end is not None and ref is not None and end <= ref - SYNC_WINDOW_S:
                        continue
                    out.append({'id': b['id'], 'start': b['start_ref'] + off, 'end': end})
        return {'ok': True, 'detector_alive': alive, 'breaks': out}

    def status_line(self):
        now = time.time()
        with self.lock:
            det, tv = self.det, self.tv
            det_ok = bool(det) and now - det['recv'] <= HEARTBEAT_S and det['capture_ok']
            tv_ok = bool(tv) and now - tv['recv'] <= HEARTBEAT_S
            parts = [f"detector {'✓' if det_ok else '✗'}"]
            if det:
                parts.append(f"ch={det['channel']} logo {det['logo']}")
            parts.append(f"  tv {'✓' if tv_ok else '✗'}")
            if tv:
                parts.append(f"ch={tv['channel']}")
            d_ref, t_ref = self.now_ref(det, now), self.now_ref(tv, now)
            if det_ok and tv_ok and d_ref is not None and t_ref is not None:
                lead = int(d_ref - t_ref)
                sign = '-' if lead < 0 else ''
                parts.append(f" lead {sign}{abs(lead) // 60}:{abs(lead) % 60:02d}")
            if tv_ok and tv.get('at_live'):
                parts.append(' TV AT LIVE (no lead)')
            if det_ok and tv_ok and det['channel'] != tv['channel']:
                parts.append(' channel mismatch')
            n_open = sum(1 for b in self.breaks.values() if b['end_ref'] is None)
            parts.append(f" breaks {len(self.breaks)} ({n_open} open)")
            if self.log_only:
                parts.append(' [log-only]')
        return ' '.join(parts)


class Handler(BaseHTTPRequestHandler):
    state = None

    def log_message(self, *a):   # keep the terminal for the status line
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == '/health':
            self._send({'ok': True})
        elif u.path == '/tv/sync':
            self._send(self.state.tv_sync(parse_qs(u.query)))
        else:
            self._send({'ok': False, 'error': 'not found'}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            n = int(self.headers.get('Content-Length', 0))
            if n > MAX_BODY:
                return self._send({'ok': False, 'error': 'too large'}, 413)
            data = json.loads(self.rfile.read(n) or b'{}')
            if not isinstance(data, dict):
                raise ValueError
        except ValueError:
            return self._send({'ok': False, 'error': 'bad json'}, 400)
        if path == '/detector/report':
            self._send(self.state.detector_report(data))
        elif path == '/detector/break':
            self._send(self.state.detector_break(data))
        elif path == '/detector/trace':
            self._send(self.state.trace(data))
        else:
            self._send({'ok': False, 'error': 'not found'}, 404)


def main():
    ap = argparse.ArgumentParser(description='Kid Ad Shield server')
    ap.add_argument('--log-only', action='store_true',
                    help='store and print breaks, but /tv/sync returns none')
    ap.add_argument('--program-start', metavar='HH:MM[:SS]',
                    help='local time of day the program started; break times in logs/ are '
                         'counted from it (default: from the first position the detector saw)')
    ap.add_argument('--fake-break', nargs=3, action='append', metavar=('START', 'END', 'CHANNEL'),
                    help="test break; START/END are ref seconds or '+N' (N s after the TV's "
                         "first reported ref); END may be 'open'; CHANNEL may be 'tv'")
    args = ap.parse_args()

    state = State(args.log_only)
    if args.program_start:
        h, m, *sec = (int(x) for x in args.program_start.split(':'))
        state.program_start_sod = h * 3600 + m * 60 + (sec[0] if sec else 0)
    state.pending_fake = [tuple(f) for f in (args.fake_break or [])]
    Handler.state = state

    # Keep the laptop display awake while we run.
    caff = None
    if shutil.which('caffeinate'):
        caff = subprocess.Popen(['caffeinate', '-d'])
        atexit.register(caff.terminate)

    def status_loop():
        while True:
            time.sleep(STATUS_EVERY_S)
            print(state.status_line(), flush=True)
    threading.Thread(target=status_loop, daemon=True).start()

    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True

    # Ctrl+C and `kill` both stop cleanly (and end caffeinate). Set explicitly
    # because background jobs can start with SIGINT ignored.
    def stop(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    print(f'Kid Ad Shield server on http://{HOST}:{PORT}'
          f"{'  [log-only]' if args.log_only else ''}  (Ctrl+C = kill switch)", flush=True)
    print(f'Break log: {state.break_log}\nScore trace: {state.trace_log}', flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\nstopping')
    finally:
        srv.server_close()
        if caff:
            caff.terminate()


if __name__ == '__main__':
    sys.exit(main())
