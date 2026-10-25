# Kid Ad Shield: ideas (running list)

Ideas to build later. Nothing here is built unless its status says so. When one is built, move what it does into `SPEC.md` and remove it from here. Numbers stay fixed, so a gap is an idea that has been built (2: shorter trivia rounds, 4: moon countdown; both in `SPEC.md`).

| # | Idea | Status | Added |
|---|---|---|---|
| 1 | [Control app for non-technical users](#1-control-app-for-non-technical-users) | Planned, waiting on answers | 2026-10-24 |
| 3 | [Add trivia questions from a phone](#3-add-trivia-questions-from-a-phone) | Idea, needs a spec decision | 2026-10-24 |
| 5 | [Test the overlay without a live stream](#5-test-the-overlay-without-a-live-stream) | Planned, answers in | 2026-10-25 |
| 6 | [Uncover button on the cover](#6-uncover-button-on-the-cover) | Planned, answers in | 2026-10-25 |

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

## 3. Add trivia questions from a phone

**Goal:** during a game, open a page on a phone, type a question (answer optional), and have it asked next.

**Conflicts with the spec:** SPEC §1 says the server "binds to `127.0.0.1` only" and "No phone remote" (the old one was removed), and §8 lists "Phone remote; LAN access" as non-goals. A phone reaches the laptop over Wi-Fi, so these must be relaxed for this one purpose.

**Proposed design:**
- Main server stays on `127.0.0.1`. A **separate small listener** on the home network (e.g. port 8789) serves only the add-question page and its POST. It can't cover, uncover, stop, or read anything else.
- A short **PIN** (shown in the control app) is required, so others on the Wi-Fi can't add questions.
- The server keeps a **priority queue**: the next `/trivia` call takes from it before the normal deck. Questions are recorded in `trivia_asked` as usual.
- "Next" means the **next rotation while covered**: if no break is on, it waits for the next one (trivia rounds are 21 s, so at most ~20 s into a break).
- The control app (idea 1) shows the phone address as a QR code. Needs a QR generator (standard library has none: a small vendored JS or Python one).
- Mac: the firewall asks once to allow incoming connections for Python. Ubuntu: `ufw` is usually off; if on, the port must be allowed.

**Open questions:**
1. OK to relax the 127.0.0.1-only / no-phone rules for a question-only listener?
2. Save phone questions into `trivia.json` for future games / use them only for this game?
3. PIN: fixed in a config file / new one each session?

---

## 5. Test the overlay without a live stream

**Goal:** open a tab, click the extension, and step through everything the TV can show (curtain closing and opening, countdown, "Back soon", trivia question and answer, recap) without YouTube TV, a game on, the detector, or `--fake-break`.

**Today:** `content.js` runs only on YouTube TV and Prime Video pages. **Cover now** / **Uncover now** in the popup (and Alt+Shift+K) give a manual cover, which shows no countdown. A countdown needs a break from the server plus the player's `ref` from `page-probe.js`, and trivia comes from the server's `/trivia`, which records each question as asked.

**Plan:**
- **Test section in the popup**, shown only in Cover mode and only while **Log details to the console** (`debug`) is ticked, under a "Test overlay" heading that starts collapsed. All test controls live here; nothing on the TV page itself. Controls:
  - **Break length** field, in seconds: default **15**, saved in `chrome.storage.local`, at least 10 (5 s curtain closing + 5 s opening, `CURTAIN_S`).
  - **Close curtain** / **Open curtain** (with the real 5 s `CURTAIN_S` animation).
  - **Break:** cover for the break length with the waning-moon countdown (SPEC "Countdown on the overlay"), then open the curtain on time.
  - **Open break:** "Back soon"; then **End it** switches to a countdown of the break length, like a real break whose end gets detected.
  - **Next question** / **Show answer now** / **Question with no answer** / **Show recap.** Needed because a 15 s break is shorter than one trivia round (`ANSWER_AFTER_S` 15 s, `TRIVIA_EVERY_S` 21 s).
  - **Server down:** shows what happens when the server stops mid-cover.
  - **Stop test:** uncovers and returns the tab to normal.
- **Any tab:** on a page where `content.js` isn't already running, the popup injects it with `chrome.scripting` (new `scripting` permission; `activeTab` is already there, so no new site access). Chrome pages (`chrome://`, the New Tab page, the Web Store) can't be injected, so the popup also offers **Open test page**: an extension page with a looping test pattern standing in for the video. It has no controls of its own; the popup drives it like any other tab.
- **Fake source inside `content.js`:** a `sim` object that, while set, stands in for `breakHit()`, `currentRef()`, `serverHealthy()` and the trivia fetch, driven by `kas-sim-*` messages from the popup. The real cover logic (`tick()`, `showOverlay()`, `openOverlay()`, `breakCountdown()`, `updateTrivia()`) runs unchanged, so what you see is what the TV would show.
- **Fully offline:** test mode never calls the server. Trivia uses a short list of **sample questions built into the extension** (a few with answers, one with none), so nothing is added to `trivia_asked`, `breaks.json` or the logs.
- **Can't leak into a real game:** test mode is off in Reporter mode, hidden unless debug logging is on, lives only in that tab's memory (gone on reload), and shows a small "TEST" tag on the overlay. Unticking debug logging stops any running test.
- Update README (new "Test the overlay" section) and SPEC.

**Decisions** (2026-10-25):
1. Controls live **in the popup**.
2. Test trivia uses **built-in sample questions**.
3. No speed control; test breaks are short instead: **break length is a setting, default 15 s**.
4. The test section shows **only when debug logging is on**.

---

## 6. Uncover button on the cover

**Goal:** during a break, click a button on the cover itself to uncover, then fast forward through the commercial with YouTube TV's own controls. One click less than opening the extension popup.

**Today:** **Uncover now** exists only in the popup (`kas-uncover-now`): it turns manual off, suppresses the break being covered so it won't re-cover, opens the curtain in 0.6 s and unmutes. While covered, the overlay (top z-index, full screen) hides the player and its controls, so there's nothing to scrub until you uncover.

**Plan:**
- A small **Uncover now** pill on the cover, in the top right corner (the recap cards use the bottom). Clicking it does exactly what the popup's Uncover now does.
- It appears only when the mouse moves over the cover and fades out after ~3 s without movement, like video player controls. Kids watching on the TV without the mouse never see it.
- Then fast forward with YouTube TV's scrubber or keys. If you land in the next break, it covers as usual; going back into the skipped break won't re-cover it (already true for Uncover now).
- **Spec:** SPEC §1 says the extension never seeks. That still holds: the button only uncovers, and the fast forward is done by you with the player's own controls. Reword the §8 non-goal "skipping or seeking past ads" to say *the extension* doesn't skip or seek.
- **Lead:** each fast-forwarded break uses up lead equal to the time skipped (lead 4:30, skip a 2:30 break → lead 2:00). At ~0 the TV is at live and nothing gets covered ahead of time. Say so in README.
- Update README (Behavior notes) and SPEC (popup Uncover now section). Check live: mouse-over shows the button, it hides again, click uncovers, fast forward past the break, next break still covers.

**Decisions** (2026-10-25):
1. Sound after clicking it on a break cover: **stays muted until the TV passes the break's end** (if the end isn't known yet, until it is known and passed, or the 180 s cap). The player's own volume can still unmute. Manual and label covers unmute right away, as today.
2. Shown on **all covers** (break, manual, label).
3. Appears **on mouse movement**, fades after ~3 s idle.
4. Fast-forwarding under the curtain with YouTube TV's keys: **not pursued**.
