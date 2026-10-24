#!/usr/bin/env python3
"""Load test for an Ubuntu laptop running both Chromes (TV + GPU-off detector).

Every few seconds logs: total CPU, CPU used by each Chrome, CPU clock and
throttle events, memory, temperature, and how busy the Intel GPU's video
decode engine is. Video engine busy > 0 while YouTube TV plays means the TV
Chrome decodes in hardware; 0 means both Chromes decode on the CPU.

Start both Chromes on the same channel first:
    google-chrome &                                                  # TV
    google-chrome --user-data-dir="$HOME/.chrome-detector" --disable-gpu &   # detector
then run:  python3 load-test.py            (Ctrl+C to stop and print a summary)
           python3 load-test.py --minutes 20
GPU numbers need intel_gpu_top (sudo apt install intel-gpu-tools) and your
sudo password once; without it everything else is still logged.
Read-only: it only reads /proc and /sys. Writes load-<hostname>-<time>.csv.
"""

import argparse
import glob
import json
import os
import shutil
import socket
import subprocess
import threading
import time
from datetime import datetime

TICK = os.sysconf('SC_CLK_TCK')
NCPU = os.cpu_count() or 1


def read(path, default=None):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return default


# ---- system ----
def cpu_times():
    """(busy, total) jiffies from the first line of /proc/stat."""
    v = [int(x) for x in read('/proc/stat').split('\n', 1)[0].split()[1:]]
    idle = v[3] + v[4]  # idle + iowait
    return sum(v) - idle, sum(v)


def meminfo():
    m = {}
    for line in read('/proc/meminfo').splitlines():
        k, rest = line.split(':', 1)
        m[k] = int(rest.split()[0]) // 1024  # MiB
    return m['MemAvailable'], m['SwapTotal'] - m['SwapFree']


def temp_c():
    """CPU package temperature, else the hottest thermal zone."""
    for z in glob.glob('/sys/class/thermal/thermal_zone*'):
        if (read(z + '/type', '') or '').strip() == 'x86_pkg_temp':
            return int(read(z + '/temp')) / 1000
    for h in glob.glob('/sys/class/hwmon/hwmon*'):
        if (read(h + '/name', '') or '').strip() == 'coretemp':
            t = read(h + '/temp1_input')
            if t:
                return int(t) / 1000
    temps = [int(t) / 1000 for t in (read(p) for p in glob.glob('/sys/class/thermal/thermal_zone*/temp')) if t]
    return max(temps) if temps else None


def cpu_mhz():
    f = [int(read(p)) for p in glob.glob('/sys/devices/system/cpu/cpu[0-9]*/cpufreq/scaling_cur_freq') if read(p)]
    return sum(f) / len(f) / 1000 if f else None


def throttle_count():
    c = [int(read(p)) for p in glob.glob('/sys/devices/system/cpu/cpu[0-9]*/thermal_throttle/*_throttle_count') if read(p)]
    return sum(c) if c else None


# ---- Chrome processes ----
def processes():
    """{pid: (ppid, cpu_jiffies, cmdline)} for every readable process."""
    out = {}
    for d in glob.glob('/proc/[0-9]*'):
        stat = read(d + '/stat')
        cmd = read(d + '/cmdline')
        if not stat or cmd is None:
            continue
        f = stat.rsplit(')', 1)[1].split()  # fields after "(comm)"
        out[int(d[6:])] = (int(f[1]), int(f[11]) + int(f[12]), cmd.replace('\0', ' '))
    return out


def pss_mib(pid):
    """Proportional memory (shared pages split between processes), so sums are honest."""
    for line in (read(f'/proc/{pid}/smaps_rollup', '') or '').splitlines():
        if line.startswith('Pss:'):
            return int(line.split()[1]) / 1024
    return 0


def chrome_groups(procs):
    """{'tv': [pids], 'detector': [pids]}: each Chrome browser process plus its descendants."""
    roots = {}
    for pid, (_, _, cmd) in procs.items():
        exe = cmd.split(' ', 1)[0]
        if exe.endswith('/chrome') and '--type=' not in cmd:
            roots[pid] = 'detector' if ('--disable-gpu' in cmd or 'chrome-detector' in cmd) else 'tv'
    groups = {'tv': [], 'detector': []}
    for pid in procs:
        p, seen = pid, 0
        while p in procs and p not in roots and seen < 50:
            p, seen = procs[p][0], seen + 1
        if p in roots:
            groups[roots[p]].append(pid)
    return groups


# ---- Intel GPU video engine (intel_gpu_top) ----
class GpuWatch:
    def __init__(self, interval):
        self.video = None   # latest video-engine busy %
        self.ok = False
        if not shutil.which('intel_gpu_top'):
            print('intel_gpu_top not found (sudo apt install intel-gpu-tools): GPU video column will be empty.')
            return
        print('intel_gpu_top needs sudo to read the GPU counters:')
        if subprocess.run(['sudo', '-v']).returncode != 0:
            print('No sudo: GPU video column will be empty.')
            return
        self.proc = subprocess.Popen(['sudo', '-n', 'intel_gpu_top', '-J', '-s', str(int(interval * 1000))],
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        dec, buf = json.JSONDecoder(), ''
        for chunk in iter(lambda: self.proc.stdout.read(1), ''):
            buf += chunk
            if chunk != '}':
                continue
            s = buf.lstrip('[, \n\t')
            try:
                obj, end = dec.raw_decode(s)
            except ValueError:
                continue
            buf = s[end:]
            engines = obj.get('engines', {})
            busy = [e.get('busy', 0) for k, e in engines.items() if k.split('/')[0] == 'Video']
            if busy:
                self.video, self.ok = max(busy), True

    def stop(self):
        if getattr(self, 'proc', None):
            self.proc.terminate()


def fmt(v, nd=1):
    return '' if v is None else f'{v:.{nd}f}'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--minutes', type=float, help='stop after this long (default: until Ctrl+C)')
    ap.add_argument('--interval', type=float, default=5, help='seconds between samples (default 5)')
    args = ap.parse_args()

    gpu = GpuWatch(args.interval)
    path = f'load-{socket.gethostname()}-{datetime.now():%Y%m%d-%H%M%S}.csv'
    cols = ['time', 'cpu_total_pct', 'tv_cpu_pct', 'detector_cpu_pct', 'load_1m', 'cpu_mhz',
            'throttle_events', 'temp_c', 'mem_avail_mib', 'swap_used_mib', 'tv_mem_mib',
            'detector_mem_mib', 'gpu_video_busy_pct']
    rows = []

    groups = chrome_groups(processes())
    if not groups['tv']:
        print('WARNING: no TV Chrome found (a chrome without --disable-gpu).')
    if not groups['detector']:
        print('WARNING: no detector Chrome found (a chrome started with --disable-gpu).')

    prev_cpu, prev_procs, prev_thr = cpu_times(), processes(), throttle_count()
    t0, prev_t = time.time(), time.time()
    print(f'Logging every {args.interval:g} s to {path}. Ctrl+C to stop.\n')
    print('  time    cpu%  tv%  det%  load   MHz  temp  avail MiB  swap  gpu-video%')
    with open(path, 'w') as out:
        out.write(','.join(cols) + '\n')
        try:
            while args.minutes is None or time.time() - t0 < args.minutes * 60:
                time.sleep(args.interval)
                now = time.time()
                dt = now - prev_t
                cpu, procs, thr = cpu_times(), processes(), throttle_count()
                groups = chrome_groups(procs)

                def group_cpu(pids):
                    j = sum(procs[p][1] - prev_procs[p][1] for p in pids if p in prev_procs)
                    return j / TICK / dt / NCPU * 100

                avail, swap = meminfo()
                r = {
                    'time': datetime.now().strftime('%H:%M:%S'),
                    'cpu_total_pct': (cpu[0] - prev_cpu[0]) / max(1, cpu[1] - prev_cpu[1]) * 100,
                    'tv_cpu_pct': group_cpu(groups['tv']),
                    'detector_cpu_pct': group_cpu(groups['detector']),
                    'load_1m': os.getloadavg()[0],
                    'cpu_mhz': cpu_mhz(),
                    'throttle_events': None if thr is None or prev_thr is None else thr - prev_thr,
                    'temp_c': temp_c(),
                    'mem_avail_mib': avail,
                    'swap_used_mib': swap,
                    'tv_mem_mib': sum(pss_mib(p) for p in groups['tv']),
                    'detector_mem_mib': sum(pss_mib(p) for p in groups['detector']),
                    'gpu_video_busy_pct': gpu.video,
                }
                rows.append(r)
                out.write(','.join(r['time'] if c == 'time' else fmt(r[c]) for c in cols) + '\n')
                out.flush()
                print(f"{r['time']}  {r['cpu_total_pct']:4.0f} {r['tv_cpu_pct']:4.0f}  {r['detector_cpu_pct']:4.0f}"
                      f"  {r['load_1m']:4.1f}  {fmt(r['cpu_mhz'], 0):>4}  {fmt(r['temp_c'], 0):>4}"
                      f"  {avail:9d}  {swap:4d}  {fmt(r['gpu_video_busy_pct']):>10}")
                prev_cpu, prev_procs, prev_thr, prev_t = cpu, procs, thr, now
        except KeyboardInterrupt:
            pass
    gpu.stop()
    summarize(rows, gpu.ok, path)


def summarize(rows, gpu_ok, path):
    if not rows:
        print('\nNo samples.')
        return

    def col(c):
        return [r[c] for r in rows if r[c] is not None]

    def avg(c):
        v = col(c)
        return sum(v) / len(v) if v else None

    print(f"\n=== Summary ({len(rows)} samples, {rows[0]['time']}-{rows[-1]['time']}) - full log in {path} ===")
    print(f"CPU total      avg {avg('cpu_total_pct'):.0f}%   max {max(col('cpu_total_pct')):.0f}%")
    print(f"  TV Chrome    avg {avg('tv_cpu_pct'):.0f}%   detector Chrome avg {avg('detector_cpu_pct'):.0f}%  (of the whole CPU)")
    print(f"Load (1 min)   avg {avg('load_1m'):.1f}   max {max(col('load_1m')):.1f}   ({NCPU} threads)")
    if col('cpu_mhz'):
        print(f"CPU clock      avg {avg('cpu_mhz'):.0f} MHz   min {min(col('cpu_mhz')):.0f} MHz")
    if col('throttle_events'):
        print(f"Throttle events {sum(col('throttle_events'))}")
    if col('temp_c'):
        print(f"Temperature    avg {avg('temp_c'):.0f} C   max {max(col('temp_c')):.0f} C")
    print(f"Memory avail   min {min(col('mem_avail_mib'))} MiB   swap used max {max(col('swap_used_mib'))} MiB")
    print(f"Chrome memory  TV avg {avg('tv_mem_mib'):.0f} MiB   detector avg {avg('detector_mem_mib'):.0f} MiB")

    print('\n=== Verdict ===')
    if not gpu_ok:
        print('- Video decode: unknown (no intel_gpu_top data). Check chrome://media-internals in the TV Chrome.')
    elif avg('gpu_video_busy_pct') > 1:
        print(f"- Video decode: HARDWARE in the TV Chrome (video engine avg {avg('gpu_video_busy_pct'):.0f}% busy).")
    else:
        print('- Video decode: SOFTWARE. The GPU video engine stayed idle, so both Chromes decode on the CPU.')
    busy = sum(1 for v in col('cpu_total_pct') if v > 90) / len(rows) * 100
    print(f"- CPU above 90% in {busy:.0f}% of samples" + (': too close to the limit, expect stutter.' if busy > 10 else '.'))
    if col('temp_c') and max(col('temp_c')) >= 90:
        print('- Ran at 90 C or more: likely throttling over a full game.')
    if max(col('swap_used_mib')) > 200 or min(col('mem_avail_mib')) < 1024:
        print('- Memory got tight (under 1 GiB available or swapping).')


if __name__ == '__main__':
    main()
