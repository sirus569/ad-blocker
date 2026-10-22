#!/usr/bin/env python3
"""Kid Ad Shield server (SPEC.md section 5.2).

Stores the breaks the detector Chrome reports and tells the TV Chrome which
ones apply. Local only (127.0.0.1). Stop it (Ctrl+C) and the TV uncovers.
Python standard library only.

  python3 server.py [--log-only] [--program-start HH:MM[:SS]] [--fake-break START END CHANNEL]

Every break the detector finds is also written to logs/breaks-<session>.log
(and a per-second score trace to logs/trace-<session>.csv) so detection quality
can be reviewed later against a recording.

Breaks are stored per program and airing in kid-ad-shield.db (SQLite, see db.py);
review them at http://127.0.0.1:8787/review.
"""
import argparse
import atexit
import json
import math
import os
import random
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from db import DB, DBError

HOST, PORT = '127.0.0.1', 8787
HERE = os.path.dirname(os.path.abspath(__file__))
BREAKS_FILE = os.path.join(HERE, 'breaks.json')   # old store: imported once into the DB
DB_FILE = os.path.join(HERE, 'kid-ad-shield.db')
REVIEW_FILE = os.path.join(HERE, 'review.html')
CONFIG_FILE = os.path.join(HERE, 'config.json')   # optional: {"offset_s": {"<channel>": 0.0}}
LOGS_DIR = os.path.join(HERE, 'logs')
TRIVIA_FILE = os.path.join(HERE, 'trivia.json')       # [{"q": ..., "a": ...}, {"q": ...}]
TEMPLATES_DIR = os.path.join(HERE, 'templates')       # learned logo masks, one file per program

ALIVE_S = 10          # detector report this recent counts as alive (/tv/sync)
HEARTBEAT_S = 3       # status line marks a part x when older than this
KEEP_S = 6 * 3600     # drop breaks starting more than this far behind the newest ref
OPEN_MAX_S = 240      # discard an open break once the detector is this far past its start
SYNC_WINDOW_S = 60    # /tv/sync leaves out breaks that ended this long before the TV's ref
STATUS_EVERY_S = 5
MAX_BODY = 256 * 1024   # a logo template is up to ~50 KB of JSON


def fnum(x):
    """float(x) if it is a finite number, else None."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def finite(x):
    """fnum() for API input: raises ValueError on anything that isn't a finite number."""
    v = fnum(x)
    if v is None:
        raise ValueError(x)
    return v


def clock(ref):
    return datetime.fromtimestamp(ref).strftime('%H:%M:%S')


def hms(sec):
    """Seconds -> H:MM:SS (e.g. 3903 -> 1:05:03)."""
    sign = '-' if sec < 0 else ''
    sec = int(round(abs(sec)))
    return f'{sign}{sec // 3600}:{sec % 3600 // 60:02d}:{sec % 60:02d}'


TRIVIA_RECENT = 4    # earlier questions sent back for the overlay's recap row


def trivia_items():
    """The usable questions in trivia.json as [{q, a}] (a None = open-ended). Re-read
    every call so the file can be edited while running; any problem (missing file,
    bad JSON, bad entries) just means no questions."""
    try:
        with open(TRIVIA_FILE) as f:
            items = json.load(f)
    except (OSError, ValueError):
        return []
    out = []
    for i in items if isinstance(items, list) else []:
        if isinstance(i, dict) and isinstance(i.get('q'), str) and i['q'].strip():
            a = i.get('a')
            out.append({'q': i['q'].strip(), 'a': a.strip() if isinstance(a, str) and a.strip() else None})
    return out


def template_path(name):
    """File for a program's template, or None if the name is unusable."""
    if not isinstance(name, str):
        return None
    slug = re.sub(r'[^A-Za-z0-9_.-]+', '_', name.strip())[:80].strip('._')
    return os.path.join(TEMPLATES_DIR, slug + '.json') if slug else None


def valid_template(t):
    try:
        return (isinstance(t, dict) and t['corner'] in (0, 1, 2, 3)
                and all(isinstance(t[k], int) and t[k] > 0 for k in ('w', 'h', 'cropW', 'cropH'))
                and isinstance(t['mask'], list) and 0 < len(t['mask']) <= t['w'] * t['h']
                and all(isinstance(i, int) and 0 <= i < t['w'] * t['h'] for i in t['mask'])
                and fnum(t['baseline']) is not None)
    except (KeyError, TypeError):
        return False


def get_template(name):
    p = template_path(name)
    if not p:
        return {'ok': False, 'error': 'bad name'}
    try:
        with open(p) as f:
            return {'ok': True, 'template': json.load(f).get('template')}
    except OSError:
        return {'ok': True, 'template': None}       # none saved yet
    except ValueError:
        return {'ok': False, 'error': 'unreadable template file'}


def put_template(d):
    """Save (or, with template null, delete) the logo template for a program."""
    name, t = d.get('name'), d.get('template')
    p = template_path(name)
    if not p:
        return {'ok': False, 'error': 'bad name'}
    if t is None:
        try:
            os.remove(p)
        except OSError:
            pass
        print(f'[template] removed "{name}"')
        return {'ok': True}
    if not valid_template(t):
        return {'ok': False, 'error': 'bad template'}
    os.makedirs(TEMPLATES_DIR, exist_ok=True)
    tmp = p + '.tmp'
    with open(tmp, 'w') as f:
        json.dump({'name': name.strip(), 'saved_at': time.time(), 'template': t}, f)
    os.replace(tmp, p)
    print(f'[template] saved "{name}" (corner {t["corner"]}, {len(t["mask"])} px)')
    return {'ok': True}


def list_templates():
    out = []
    try:
        files = sorted(os.listdir(TEMPLATES_DIR))
    except OSError:
        files = []
    for fn in files:
        if not fn.endswith('.json'):
            continue
        try:
            with open(os.path.join(TEMPLATES_DIR, fn)) as f:
                d = json.load(f)
            out.append({'name': d['name'], 'saved_at': d.get('saved_at'),
                        'corner': d['template']['corner'], 'pixels': len(d['template']['mask'])})
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return {'ok': True, 'templates': out}


def program_name(raw, channel):
    """The program a break belongs to: the detector's chosen program, else per channel."""
    name = raw.strip()[:80] if isinstance(raw, str) else ''
    return name or f'channel {channel}'


class State:
    def __init__(self, log_only, program_start_sod=None):
        self.lock = threading.Lock()
        self.log_only = log_only
        self.db = DB(DB_FILE, program_start_sod)
        self.det_touch_at = 0     # last time the detector's airing was updated
        self.fallback_id = -1     # break ids if the DB ever fails (live covering must go on)
        self.trivia_mem = {}      # channel -> questions asked, when no airing is known
        self.det = {}        # latest detector report + 'recv' (server time received)
        self.tv = {}         # latest TV sync params + 'recv'
        self.breaks = {}     # key -> break dict
        self.next_id = 1_000_000   # fake (test) breaks only; real ones get DB ids
        self.pending_fake = []   # (start, end, channel) where start/end may be '+N' strings
        self.offsets = {}
        self.origins = {}          # channel -> ref that counts as program time 0:00:00
        self.program_start_sod = program_start_sod   # --program-start as seconds since local midnight
        stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
        self.break_log = os.path.join(LOGS_DIR, f'breaks-{stamp}.log')
        self.trace_log = os.path.join(LOGS_DIR, f'trace-{stamp}.csv')
        self.trace_meta = None
        self.load()

    # ---- persistence (SQLite, see db.py) ----
    def _db(self, fn, *args):
        """Run a DB call; on any DB error log it and return None. The live path
        (covering the TV) must never fail because of storage."""
        try:
            return fn(*args)
        except sqlite3.Error as e:
            print(f'[db] error: {e}')
            return None

    def load(self):
        try:
            with open(CONFIG_FILE) as f:
                self.offsets = {k: float(v) for k, v in json.load(f).get('offset_s', {}).items()}
        except (OSError, ValueError):
            pass
        if self.db.empty() and os.path.exists(BREAKS_FILE):
            self.import_breaks_json()
        for b in self.db.recent_live(time.time() - KEEP_S):
            self.breaks[b['key']] = {**b, 'fake': False}

    def import_breaks_json(self):
        """One-time move of the old breaks.json into the DB (as per-channel programs)."""
        try:
            with open(BREAKS_FILE) as f:
                items = json.load(f)
        except (OSError, ValueError):
            return
        n = 0
        for b in items:
            try:
                aid = self.db.airing(program_name('', b['channel']), b['channel'], b['start_ref'])
                self.db.upsert_break(b['key'], aid, b['start_ref'], b.get('end_ref'))
                n += 1
            except (KeyError, TypeError, sqlite3.Error):
                continue
        print(f'[db] imported {n} breaks from breaks.json (the file is left as it is)')

    # ---- trivia ----
    def trivia(self, channel):
        """Next question for the TV's cover. Questions don't repeat within a game (the
        airing on that channel) until every question has been asked. Also returns the
        last few asked before it, newest first, for the overlay's recap row."""
        items = trivia_items()
        aid = self._db(self.db.current_airing, channel) if channel else None
        asked = self._db(self.db.trivia_asked, aid) if aid else None
        in_db = asked is not None
        if not in_db:                           # no game known (or DB trouble): remember for this run
            asked = self.trivia_mem.setdefault(channel or '', [])
        recent = []                             # newest first, each question once
        for x in reversed(asked):
            if len(recent) == TRIVIA_RECENT:
                break
            if all(r['q'] != x['q'] for r in recent):
                recent.append({'q': x['q'], 'a': x['a']})
        if not items:
            return {'ok': True, 'question': None, 'answer': None, 'recent': recent}
        # Deal like a shuffled deck: no repeats until every question has been asked,
        # then a fresh round (only this round's questions count as used).
        this_round = asked[len(asked) - len(asked) % len(items):]
        seen = {x['q'] for x in this_round}
        pick = random.choice([i for i in items if i['q'] not in seen] or items)
        if in_db:
            with self.lock:
                tv_ref = self.now_ref(self.tv, time.time()) if self.tv.get('channel') == channel else None
            self._db(self.db.record_trivia, aid, pick['q'], pick['a'], tv_ref)
        else:
            asked.append(pick)
        return {'ok': True, 'question': pick['q'], 'answer': pick['a'], 'recent': recent}

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
                    self._db(self.db.discard, key)
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
            if program_name(d.get('program'), ch) != self.det.get('program'):
                self.det_touch_at = 0
            self.det = {'channel': ch, 'ref': fnum(d.get('ref')), 'at_live': bool(d.get('at_live')),
                        'paused': bool(d.get('paused')), 'capture_ok': bool(d.get('capture_ok')),
                        'logo': str(d.get('logo', '?')), 'recv': now,
                        'program': program_name(d.get('program'), ch)}
            # Keep the detector's airing current (creates it on the first report).
            if self.det['ref'] is not None and now - self.det_touch_at >= 30:
                self.det_touch_at = now
                self._db(self.db.airing, self.det['program'], ch, self.det['ref'])
            if self.det['ref'] is not None and self.program_start_sod is None:
                self.origins.setdefault(ch, self.det['ref'])
            self.maintain(now)
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
            prog = program_name(d.get('program') or self.det.get('program', ''), ch)
            aid = self._db(self.db.airing, prog, ch, start)
            bid = self._db(self.db.upsert_break, key, aid, start, end) if aid else None
            b = self.breaks.get(key)
            new = b is None
            if new:
                if bid is None:
                    bid, self.fallback_id = self.fallback_id, self.fallback_id - 1
                b = {'id': bid, 'key': key, 'fake': False}
                self.breaks[key] = b
            was_open = new or b['end_ref'] is None
            b.update(channel=ch, start_ref=start, end_ref=end, confirmed_at=time.time())
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
            self.maintain(now)
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
                parts.append(f"ch={det['channel']} prog=\"{det.get('program', '')}\" logo {det['logo']}")
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
        if not self.path.startswith('/api/'):   # the review API is for the review page only
            self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _api(self, fn):
        """Run a review-API call; turn bad requests into readable errors."""
        try:
            return self._send({'ok': True, **(fn() or {})})
        except DBError as e:
            return self._send({'ok': False, 'error': str(e)}, 400)
        except (KeyError, TypeError, ValueError):
            return self._send({'ok': False, 'error': 'bad request'}, 400)
        except sqlite3.Error as e:
            return self._send({'ok': False, 'error': f'database error: {e}'}, 500)

    def _same_origin(self):
        """Review-API writes only from the review page itself, so a website open in
        the same browser can't change the data on this local server."""
        origin = self.headers.get('Origin')
        ok_origin = origin in (None, f'http://{HOST}:{PORT}', f'http://localhost:{PORT}')
        return ok_origin and (self.headers.get('Content-Type') or '').startswith('application/json')

    def do_OPTIONS(self):
        if self.path.startswith('/api/'):
            self.send_response(403)   # no cross-site preflight for the review API
            self.end_headers()
            return
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == '/health':
            self._send({'ok': True})
        elif u.path == '/trivia':
            self._send(self.state.trivia(parse_qs(u.query).get('channel', [''])[0]))
        elif u.path == '/templates':
            self._send(list_templates())
        elif u.path == '/template':
            self._send(get_template(parse_qs(u.query).get('name', [''])[0]))
        elif u.path == '/tv/sync':
            self._send(self.state.tv_sync(parse_qs(u.query)))
        elif u.path == '/review':
            try:
                with open(REVIEW_FILE, 'rb') as f:
                    body = f.read()
            except OSError:
                return self._send({'ok': False, 'error': 'review.html missing'}, 404)
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
        elif u.path == '/api/programs':
            self._api(lambda: {'programs': self.state.db.programs()})
        elif u.path == '/api/airing':
            self._api(lambda: {'airing': self.state.db.airing_detail(int(parse_qs(u.query)['id'][0]))})
        else:
            self._send({'ok': False, 'error': 'not found'}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path.startswith('/api/') and not self._same_origin():
            return self._send({'ok': False, 'error': 'forbidden'}, 403)
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
        elif path == '/template':
            self._send(put_template(data))
        elif path.startswith('/api/'):
            db = self.state.db
            routes = {
                '/api/airing/start': lambda: db.set_start(int(data['id']), finite(data['start_ref'])),
                '/api/mark': lambda: db.set_mark(int(data['break_id']), data['edge'], data.get('verdict'),
                                                 None if data.get('seconds') is None else finite(data['seconds'])),
                '/api/merge': lambda: {'id': db.merge(int(data['a']), int(data['b']))},
                '/api/unmerge': lambda: db.unmerge(int(data['id'])),
            }
            if path not in routes:
                return self._send({'ok': False, 'error': 'not found'}, 404)
            self._api(routes[path])
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

    sod = None
    if args.program_start:
        h, m, *sec = (int(x) for x in args.program_start.split(':'))
        sod = h * 3600 + m * 60 + (sec[0] if sec else 0)
    state = State(args.log_only, sod)
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
