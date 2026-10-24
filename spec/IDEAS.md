# Kid Ad Shield: ideas (running list)

Ideas to build later. Nothing here is built unless its status says so. When one is built, move what it does into `SPEC.md` and mark it **Done** here.

| # | Idea | Status | Added |
|---|---|---|---|
| 1 | [Control app for non-technical users](#1-control-app-for-non-technical-users) | Planned, waiting on answers | 2026-10-24 |
| 2 | [Shorter gap between trivia questions](#2-shorter-gap-between-trivia-questions) | Planned, waiting on answers | 2026-10-24 |
| 3 | [Add trivia questions from a phone](#3-add-trivia-questions-from-a-phone) | Idea, needs a spec decision | 2026-10-24 |

---

## 1. Control app for non-technical users

**Goal:** one icon to start everything, and one screen that shows whether it's working, so nobody needs a Terminal.

**Approach:** `app/control.py` (Python standard library only, like `server.py`) on `127.0.0.1:8786`. It starts `server.py` as a child process, launches both Chromes, and serves a dashboard page that opens in a Chrome `--app` window (no tabs or address bar). Same code on Mac and Ubuntu. Rejected: Tkinter (Ubuntu needs `python3-tk`; old Tk on the Mac), Electron/Qt (big dependencies, packaging and signing).

**Dashboard:**
- **Server:** Running / Stopped, **Start**, big red **Stop** (= the kill switch, like Ctrl+C today). Log-only mode under "Advanced".
- **Launch Chromes:** opens TV Chrome and detector Chrome with the same flags and the same "already running without `--disable-gpu`" warning as `app/launch-chromes-ubuntu.sh`.
- **Detector card:** connected (seconds since last report), capture running, channel, program, logo (Learning / Found / None).
- **Logo picture:** a 16:9 outline with the chosen corner highlighted and the learned mask pixels drawn in place, from the saved template (`GET /template?name=<program>`: `corner`, `w`, `h`, `cropW`, `cropH`, `mask`).
- **TV card:** connected, channel, "at live" / "channel mismatch" warnings, covered right now.
- **Lead:** large "4:32 ahead", green / amber / red, with "pause the TV to rebuild it" when low.
- **Checklist:** the README's "Each time" steps tick green as the server confirms them. **Start capture** (detector popup) and **Start** (TV popup) stay manual: Chrome allows tab capture only after a real click on the extension.
- **Log, two tabs:** *Pretty* (plain events: "Commercial started at 1:05:03", "Back to the game (2 min 20 s)", "Learned the ESPN logo", red error cards) and *Raw* (everything `server.py` prints, with a toggle to hide the 5 s status line). The raw log of each session is also saved to `app/server/logs/console-<time>.log`.

**Changes to existing code:**
- `server.py`: add `GET /status` (detector, TV, lead, breaks as JSON). Today this exists only inside the printed status line.
- Run the server as `python3 -u`: most `print` calls don't flush, so piped output would arrive late.
- Endpoints in `control.py` that start or stop processes accept only same-origin JSON POSTs (like the review API), so a web page can't stop the server.
- Keep `app/launch-chromes-ubuntu.sh` as a fallback.
- README: "Easy start" section, command-line steps under "Advanced". SPEC: new section.

**Phases:**
1. `control.py` + `/status` + dashboard (start/stop, launch, status cards, both logs). Test on Ubuntu with the real Chromes and `--fake-break`.
2. Logo picture from the saved template.
3. Desktop launchers: Ubuntu app-grid entry (`.desktop` + icon, via an install script) and a Mac `Kid Ad Shield.app`.
4. *(optional)* Live detector thumbnail like the debug page: the extension posts a small JPEG to the server every few seconds while the dashboard is open (extension change + server endpoint).
5. First-time setup screen: Chrome 116+ found, copy the extension path, create and color the detector profile, Mac Spaces setting.

**Limits:** on Wayland (Ubuntu default) the app can't position windows; the TV window is still dragged to the TV. Macs don't ship Python 3 (first run prompts for Apple's Command Line Tools). An unsigned `.app` must be allowed once in System Settings → Privacy & Security. Mac parts can't be tested on the Ubuntu laptop.

**Open questions** (recommended answer first):
1. Closing the dashboard window: **stops the server** after a 10 s grace (a reload doesn't count) / server keeps running until Stop.
2. Stop button: **leaves both Chromes open** / also closes the detector Chrome.
3. Live thumbnail (phase 4): **skip for now** / include.
4. Mac: tested on a real Mac with an unsigned `.app` / Ubuntu only for now.
5. Log-only mode: **under "Advanced"** / on the main screen.

---

## 2. Shorter gap between trivia questions

**Problem:** after the answer appears, the next question takes 15 s. In `app/extension/content.js`, `ANSWER_AFTER_S = 15` reveals the answer and `TRIVIA_EVERY_S = 30` brings the next question, so the answer stays up for 15 s.

**Plan:** add a separate answer-hold time (about **6 s**): next question = question time (15 s) + hold. A round goes from 30 s to about 21 s; the question still gets 15 s. Update the timings in README "Overlay and trivia" and in SPEC. After the change: reload the extension and the TV tab, check with `--fake-break`.

**Open questions:**
1. Answer hold: **6 s** / 10 s / other.
2. Questions with no right answer ("Talk it over!"): same gap / keep 15 s for discussion.

---

## 3. Add trivia questions from a phone

**Goal:** during a game, open a page on a phone, type a question (answer optional), and have it asked next.

**Conflicts with the spec:** SPEC §1 says the server "binds to `127.0.0.1` only" and "No phone remote" (the old one was removed), and §8 lists "Phone remote; LAN access" as non-goals. A phone reaches the laptop over Wi-Fi, so these must be relaxed for this one purpose.

**Proposed design:**
- Main server stays on `127.0.0.1`. A **separate small listener** on the home network (e.g. port 8789) serves only the add-question page and its POST. It can't cover, uncover, stop, or read anything else.
- A short **PIN** (shown in the control app) is required, so others on the Wi-Fi can't add questions.
- The server keeps a **priority queue**: the next `/trivia` call takes from it before the normal deck. Questions are recorded in `trivia_asked` as usual.
- "Next" means the **next rotation while covered**: if no break is on, it waits for the next one (with idea 2, at most ~20 s into a break).
- The control app (idea 1) shows the phone address as a QR code. Needs a QR generator (standard library has none: a small vendored JS or Python one).
- Mac: the firewall asks once to allow incoming connections for Python. Ubuntu: `ufw` is usually off; if on, the port must be allowed.

**Open questions:**
1. OK to relax the 127.0.0.1-only / no-phone rules for a question-only listener?
2. Save phone questions into `trivia.json` for future games / use them only for this game?
3. PIN: fixed in a config file / new one each session?
