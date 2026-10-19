"""SQLite store for Kid Ad Shield: programs, their airings, and each airing's breaks.

A program is a name like "NBC SNF" (the same names the detector's dropdown uses).
An airing is one showing of it on one channel; a new airing starts when that
program/channel has been quiet for AIRING_GAP_S. Breaks belong to an airing.

Times are stored as broadcast content timestamps (`ref`, Unix seconds, the same
timeline the TV uses). The review page shows them as program time: seconds since
the airing's `start_ref`, which the user can correct while watching a recording.

Python standard library only. All methods are thread-safe (one connection, one lock).
"""
import sqlite3
import threading
import time
from datetime import datetime

AIRING_GAP_S = 3 * 3600

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS programs (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS airings (
  id           INTEGER PRIMARY KEY,
  program_id   INTEGER NOT NULL REFERENCES programs(id),
  channel      TEXT NOT NULL,
  first_ref    REAL NOT NULL,   -- first content time the detector reported
  last_ref     REAL NOT NULL,   -- latest content time seen (groups reports into airings)
  start_ref    REAL NOT NULL,   -- program time 0:00:00 (editable on the review page)
  start_source TEXT NOT NULL,   -- 'detector' | 'flag' (--program-start) | 'user'
  created_at   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS airings_by_program ON airings(program_id, channel, last_ref);
CREATE TABLE IF NOT EXISTS breaks (
  id           INTEGER PRIMARY KEY,
  airing_id    INTEGER NOT NULL REFERENCES airings(id),
  key          TEXT NOT NULL UNIQUE,                 -- detector's key, or 'merge:<a>:<b>'
  start_ref    REAL NOT NULL,
  end_ref      REAL,                                 -- NULL while open
  source       TEXT NOT NULL DEFAULT 'detector',     -- 'detector' | 'merge'
  status       TEXT NOT NULL DEFAULT 'ok',           -- 'ok' | 'discarded' (never closed)
  merged_into  INTEGER REFERENCES breaks(id),        -- set on both originals of a merge
  confirmed_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS breaks_by_airing ON breaks(airing_id, start_ref);
CREATE TABLE IF NOT EXISTS marks (
  break_id   INTEGER NOT NULL REFERENCES breaks(id) ON DELETE CASCADE,
  edge       TEXT NOT NULL CHECK (edge IN ('start', 'end')),
  verdict    TEXT NOT NULL CHECK (verdict IN ('early', 'late')),
  seconds    REAL NOT NULL CHECK (seconds >= 0),
  updated_at REAL NOT NULL,
  PRIMARY KEY (break_id, edge)
);
"""


class DBError(Exception):
    """A request the review page made that can't be done (shown to the user)."""


class DB:
    def __init__(self, path, program_start_sod=None):
        self.lock = threading.Lock()
        self.program_start_sod = program_start_sod   # --program-start, seconds since local midnight
        self.conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute('PRAGMA journal_mode = WAL')
        self.conn.executescript(SCHEMA)

    def _all(self, sql, args=()):
        return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    def _one(self, sql, args=()):
        r = self.conn.execute(sql, args).fetchone()
        return dict(r) if r else None

    # ---------- written by the live detector path ----------

    def _flag_start(self, ref):
        """--program-start as an absolute ref on the same day as `ref` (or the day before)."""
        base = datetime.fromtimestamp(ref).replace(hour=0, minute=0, second=0, microsecond=0)
        o = base.timestamp() + self.program_start_sod
        return o - 86400 if o > ref else o

    def airing(self, program, channel, ref):
        """The airing `ref` belongs to, created if needed. Returns its id."""
        with self.lock:
            self.conn.execute('INSERT OR IGNORE INTO programs(name) VALUES (?)', (program,))
            pid = self._one('SELECT id FROM programs WHERE name = ?', (program,))['id']
            a = self._one('SELECT id, last_ref FROM airings WHERE program_id = ? AND channel = ? '
                          'AND last_ref >= ? AND first_ref <= ? ORDER BY last_ref DESC LIMIT 1',
                          (pid, channel, ref - AIRING_GAP_S, ref + AIRING_GAP_S))
            if a:
                if ref > a['last_ref']:
                    self.conn.execute('UPDATE airings SET last_ref = ? WHERE id = ?', (ref, a['id']))
                return a['id']
            if self.program_start_sod is not None:
                start, source = self._flag_start(ref), 'flag'
            else:
                start, source = ref, 'detector'
            cur = self.conn.execute(
                'INSERT INTO airings(program_id, channel, first_ref, last_ref, start_ref, start_source, created_at) '
                'VALUES (?, ?, ?, ?, ?, ?, ?)', (pid, channel, ref, ref, start, source, time.time()))
            print(f'[db] new airing {cur.lastrowid}: "{program}" on {channel}')
            return cur.lastrowid

    def upsert_break(self, key, airing_id, start_ref, end_ref):
        """Insert or update a detector break by key. Returns its id."""
        with self.lock:
            self.conn.execute(
                'INSERT INTO breaks(airing_id, key, start_ref, end_ref, confirmed_at) VALUES (?, ?, ?, ?, ?) '
                'ON CONFLICT(key) DO UPDATE SET start_ref = excluded.start_ref, end_ref = excluded.end_ref, '
                'confirmed_at = excluded.confirmed_at, status = \'ok\'',
                (airing_id, key, start_ref, end_ref, time.time()))
            return self._one('SELECT id FROM breaks WHERE key = ?', (key,))['id']

    def discard(self, key):
        """An open break whose end never arrived: keep it out of reviews."""
        with self.lock:
            self.conn.execute("UPDATE breaks SET status = 'discarded' WHERE key = ? AND end_ref IS NULL", (key,))

    def recent_live(self, since_ref):
        """Detector breaks to load into the live (in-memory) list at startup."""
        with self.lock:
            return self._all(
                "SELECT b.id, b.key, a.channel, b.start_ref, b.end_ref, b.confirmed_at FROM breaks b "
                "JOIN airings a ON a.id = b.airing_id WHERE b.source = 'detector' AND b.status = 'ok' "
                "AND b.start_ref >= ?", (since_ref,))

    def empty(self):
        with self.lock:
            return self._one('SELECT COUNT(*) AS n FROM breaks')['n'] == 0

    # ---------- read by the review page ----------

    def programs(self):
        with self.lock:
            progs = self._all('SELECT id, name FROM programs ORDER BY name COLLATE NOCASE')
            airings = self._all(
                "SELECT a.id, a.program_id, a.channel, a.first_ref, a.start_ref, a.start_source, "
                "(SELECT COUNT(*) FROM breaks b WHERE b.airing_id = a.id AND b.status = 'ok' "
                " AND b.merged_into IS NULL) AS breaks FROM airings a ORDER BY a.first_ref DESC")
        for p in progs:
            p['airings'] = [a for a in airings if a['program_id'] == p['id']]
        return [p for p in progs if p['airings']]

    def airing_detail(self, airing_id):
        with self.lock:
            a = self._one('SELECT a.*, p.name AS program FROM airings a JOIN programs p ON p.id = a.program_id '
                          'WHERE a.id = ?', (airing_id,))
            if not a:
                raise DBError('no such airing')
            breaks = self._all("SELECT id, key, start_ref, end_ref, source, merged_into FROM breaks "
                               "WHERE airing_id = ? AND status = 'ok' ORDER BY start_ref, id", (airing_id,))
            marks = self._all('SELECT m.break_id, m.edge, m.verdict, m.seconds FROM marks m '
                              'JOIN breaks b ON b.id = m.break_id WHERE b.airing_id = ?', (airing_id,))
        for b in breaks:
            b['marks'] = {m['edge']: {'verdict': m['verdict'], 'seconds': m['seconds']}
                          for m in marks if m['break_id'] == b['id']}
            if b['source'] == 'merge':
                b['parts'] = [x['id'] for x in breaks if x['merged_into'] == b['id']]
        a['breaks'] = breaks
        return a

    # ---------- written by the review page ----------

    def set_start(self, airing_id, start_ref):
        with self.lock:
            n = self.conn.execute("UPDATE airings SET start_ref = ?, start_source = 'user' WHERE id = ?",
                                  (start_ref, airing_id)).rowcount
        if not n:
            raise DBError('no such airing')

    def set_mark(self, break_id, edge, verdict, seconds):
        """verdict 'early' / 'late' with seconds >= 0, or None to clear the mark."""
        if edge not in ('start', 'end'):
            raise DBError('edge must be start or end')
        with self.lock:
            if not self._one("SELECT id FROM breaks WHERE id = ? AND status = 'ok'", (break_id,)):
                raise DBError('no such break')
            if verdict is None:
                self.conn.execute('DELETE FROM marks WHERE break_id = ? AND edge = ?', (break_id, edge))
                return
            if verdict not in ('early', 'late') or seconds is None or seconds < 0:
                raise DBError('verdict must be early or late, with seconds >= 0')
            self.conn.execute(
                'INSERT INTO marks(break_id, edge, verdict, seconds, updated_at) VALUES (?, ?, ?, ?, ?) '
                'ON CONFLICT(break_id, edge) DO UPDATE SET verdict = excluded.verdict, '
                'seconds = excluded.seconds, updated_at = excluded.updated_at',
                (break_id, edge, verdict, seconds, time.time()))

    def merge(self, a_id, b_id):
        """Join break `a` with the break right after it (one break that the
        detector split in two). Both originals are kept and can be restored."""
        with self.lock:
            a = self._one("SELECT * FROM breaks WHERE id = ? AND status = 'ok' AND merged_into IS NULL", (a_id,))
            b = self._one("SELECT * FROM breaks WHERE id = ? AND status = 'ok' AND merged_into IS NULL", (b_id,))
            if not a or not b or a['airing_id'] != b['airing_id']:
                raise DBError('both breaks must exist, be unmerged, and belong to the same airing')
            if a['end_ref'] is None or b['end_ref'] is None:
                raise DBError('only finished breaks can be merged')
            if (b['start_ref'], b['id']) < (a['start_ref'], a['id']):
                a, b = b, a
            between = self._one(
                "SELECT COUNT(*) AS n FROM breaks WHERE airing_id = ? AND status = 'ok' AND merged_into IS NULL "
                "AND id NOT IN (?, ?) AND start_ref >= ? AND start_ref <= ?",
                (a['airing_id'], a['id'], b['id'], a['start_ref'], b['start_ref']))['n']
            if between:
                raise DBError('only breaks next to each other can be merged')
            cur = self.conn.execute(
                "INSERT INTO breaks(airing_id, key, start_ref, end_ref, source, confirmed_at) "
                "VALUES (?, ?, ?, ?, 'merge', ?)",
                (a['airing_id'], f"merge:{a['id']}:{b['id']}", a['start_ref'],
                 max(a['end_ref'], b['end_ref']), time.time()))
            mid = cur.lastrowid
            self.conn.execute('UPDATE breaks SET merged_into = ? WHERE id IN (?, ?)', (mid, a['id'], b['id']))
            # The merged break's start is the first break's start, its end the second's end.
            for src, edge in ((a['id'], 'start'), (b['id'], 'end')):
                self.conn.execute(
                    'INSERT INTO marks(break_id, edge, verdict, seconds, updated_at) '
                    'SELECT ?, edge, verdict, seconds, ? FROM marks WHERE break_id = ? AND edge = ?',
                    (mid, time.time(), src, edge))
            return mid

    def unmerge(self, merged_id):
        with self.lock:
            m = self._one("SELECT id FROM breaks WHERE id = ? AND source = 'merge' AND merged_into IS NULL",
                          (merged_id,))
            if not m:
                raise DBError('not a merged break (or it was merged again; unmerge that first)')
            self.conn.execute('UPDATE breaks SET merged_into = NULL WHERE merged_into = ?', (merged_id,))
            self.conn.execute('DELETE FROM breaks WHERE id = ?', (merged_id,))
