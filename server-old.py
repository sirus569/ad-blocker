#!/usr/bin/env python3
"""Kid Ad Shield remote server.

Run this on the Mac that plays Prime Video in Chrome:

    python3 server.py

Then open the address it prints on your phone (same Wi-Fi network).
Uses only Python's standard library.
"""

import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = 8787
HERE = Path(__file__).resolve().parent
TV_TIMEOUT = 5  # seconds without a check-in before the TV counts as disconnected

lock = threading.Lock()
state = {
    "cover": False,        # what the phone asked for
    "tv_covered": False,   # what the extension is actually doing
    "tv_reason": "",
    "tv_seen": 0.0,
}


def snapshot():
    with lock:
        return {
            "cover": state["cover"],
            "tv_connected": time.time() - state["tv_seen"] < TV_TIMEOUT,
            "tv_covered": state["tv_covered"],
            "tv_reason": state["tv_reason"],
        }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError):
            return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path in ("/", "/index.html"):
            self._send(200, (HERE / "remote.html").read_bytes(), "text/html; charset=utf-8")
        elif path == "/state":
            if "from=tv" in query:
                with lock:
                    state["tv_seen"] = time.time()
            self._send(200, snapshot())
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        body = self._body()
        if self.path == "/set":
            with lock:
                state["cover"] = bool(body.get("cover"))
            print("Phone:", "cover ON" if state["cover"] else "cover OFF", flush=True)
            self._send(200, snapshot())
        elif self.path == "/report":
            with lock:
                state["tv_covered"] = bool(body.get("covered"))
                state["tv_reason"] = str(body.get("reason") or "")[:80]
                state["tv_seen"] = time.time()
            self._send(200, {"ok": True})
        else:
            self._send(404, {"error": "not found"})

    def log_message(self, *_):
        pass  # keep the terminal quiet


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packet is sent; this just picks the LAN interface
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    ip = lan_ip()
    host = socket.gethostname()
    if not host.endswith(".local"):
        host += ".local"
    print("Kid Ad Shield remote is running.")
    print("Open one of these on your phone:")
    if ip:
        print(f"  http://{ip}:{PORT}")
    print(f"  http://{host}:{PORT}")
    print("Press Control+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
