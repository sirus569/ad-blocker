# Kid Ad Shield: ideas (running list)

Ideas to build later. Nothing here is built unless its status says so. When one is built, move what it does into `SPEC.md` and remove it from here. Numbers stay fixed, so a gap is an idea that has been built (2: shorter trivia rounds, 4: moon countdown, 7: countdown ring and scenes; all in `SPEC.md`).

| # | Idea | Status | Added |
|---|---|---|---|
| 1 | [Control app for non-technical users](#1-control-app-for-non-technical-users) | Planned, waiting on answers | 2026-10-24 |
| 3 | [Add trivia questions from a phone](#3-add-trivia-questions-from-a-phone) | Idea, needs a spec decision | 2026-10-24 |
| 5 | [Test the overlay without a live stream](#5-test-the-overlay-without-a-live-stream) | Planned, answers in | 2026-10-25 |
| 6 | [Uncover button on the cover](#6-uncover-button-on-the-cover) | Planned, answers in | 2026-10-25 |
| 7 | [Fast-forward through breaks when far behind](#7-fast-forward-through-breaks-when-far-behind) | Planned, answers in | 2026-10-25 |

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

---

## 7. Fast-forward through breaks when far behind

**Goal:** when the TV is watching a recording, or is more than 45 min behind, jump over each break instead of covering it. The TV lands where the curtain would have been opening (a few seconds before the game is back), and a faint **» » » »** shows in the bottom-right corner for 2 s so you know it skipped.

**Conflicts with the spec:** SPEC §1 is a hard rule: "Never skip, block, seek past, or speed up ads ... never call the YouTube player's `seekTo`, `seekBy` ...". `page-probe.js` and `content.js` both say they never seek, README line 1 says "Never skips ads", and §8 lists "skipping or seeking past ads" as a non-goal. Idea 6 also leans on "the extension never seeks". All of these must be reworded to: *never seeks during live events; during replays (a recording, or 45+ min behind live) it may seek forward over a break whose end is known*. Covering stays exactly as it is everywhere else.

**When it fast-forwards** (all must hold, checked every 250 ms tick like the cover decision):
- Cover mode, running, server healthy, a fresh `ref` (same gates as covering).
- The TV is **far behind**: `now - ref - 20 s` (broadcast latency, SPEC §3) ≥ **45 min**. This needs no detector. (A chosen, lined-up recording counts as a replay without this test; see Recordings.) As each skip uses up lead, the TV eventually drops under 45 min and goes back to normal covering.
- The break is **closed** (end known). Open breaks are never skipped; they cover as today.
- `start ≤ ref < land - 1 s`, where `land = end - FF_LAND_S` (default 4 s: the middle of today's curtain opening, which runs from `end - 6.5` to `end - 1.5`).

**How it skips:**
- A new MAIN-world script `page-seek.js` (tv.youtube.com only), separate from `page-probe.js` so the probe stays read-only. It listens for a `kas-seek` event with a `delta` in seconds and calls `player.seekTo(player.getCurrentTime() + delta, true)`. `getCurrentTime()` (stream time) moves 1:1 with `ref` (SPEC §3), so `delta = land - ref`. Forward only: it refuses `delta ≤ 0` or more than 15 min.
- `content.js` mutes the moment it sends the seek and keeps the sound off until `end - END_EARLY`, like the curtain does today, so the 2-4 s of ad tail after landing is silent. No curtain: the picture is visible the whole time.
- After landing, `ref` sits in `[land - 1, end)`: too late to seek again and outside the cover rule for skippable breaks, so nothing covers. Rewinding into a skipped break and playing skips it again (no "suppressed" list needed).
- **Check it worked:** if 3 s after the seek `ref` is not within 2 s of `land`, send one correcting seek; if that also misses, give up on skipping that break and cover it normally (e.g. a recording that doesn't allow fast forward). Log each skip with `debug` on.
- Breaks longer than the 180 s cap are skipped whole, so their tail no longer leaks.
- YouTube TV may flash its own seek bar or a spinner during the jump; a frame of the ad may show before the jump lands.

**The » » » » badge:** its own small host element (shadow DOM, like the overlay), placed with `overlayParent()` so it shows in fullscreen. Bottom-right, ~4% in from the edges, white chevrons at ~70% opacity with a soft shadow on a faint dark pill, fades in, holds, fades out over 2 s total. Never blocks clicks (`pointer-events: none`).

**Server:** for the long-pause case, nothing changes: the breaks are already in `/tv/sync`. Optional: show `FF` in the status line while the TV is far behind.

**Recordings (phase 2).** A recording most likely does **not** report the original broadcast time through `getMediaReferenceTime()` (user's expectation, 2026-10-26), so its breaks can't be matched by `ref` directly. Instead breaks are placed in the recording by their **offset into the program** (program time), plus where the program starts in the recording, set once per recording with a line-up step.

*Still to check on a real recording* (read-only console snippet `kas()`, see below), to choose the recording clock and its zero:
1. Its URL (`/watch/<id>?...`): stable each time the same recording is opened? (Used to remember which airing it is.)
2. Which player value counts the recording's position: `getCurrentTime()`, `video.currentTime`, or `getMediaReferenceTime()`, and what each reads at the very start of the recording. The one used must rise 1:1 with play and by the seek amount on a seek, and hold still while paused.
3. Does the recording keep the broadcast's own breaks, or does YouTube TV swap in its own labeled ads (nothing to skip; label detection covers them)?
4. Does seeking forward work on it?

`kas = () => { const p = document.querySelector('.html5-video-player') || document.querySelector('#movie_player'); const v = [...document.querySelectorAll('video')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]; const r = p.getMediaReferenceTime(); return { path: location.pathname + location.search, ref: r, clock: new Date(r * 1000).toLocaleString(), atLive: p.isAtLiveHead && p.isAtLiveHead(), stream: p.getCurrentTime(), duration: p.getDuration && p.getDuration(), videoTime: v && v.currentTime, title: p.getVideoData && p.getVideoData().title }; }` (Console context **top**.)

**Picking the recording (TV popup, cover mode).** A **Replay of** dropdown under the fast-forward checkbox, filled from the programs in `kid-ad-shield.db` (the same list as the review page's `GET /api/programs`). Each entry is one airing, grouped by program and newest first, e.g. `NBC SNF · Sun Oct 19 · 7 breaks`, because one program airs every week and each airing has its own breaks. Airings with no finished breaks are left out. The first entry, **Live (none)**, is today's behavior and the default.
- The choice is tied to the **recording's URL** (the tab's path when chosen) and saved on the airing in the DB (`airings.replay_path`). On any other page, including the live channel, it is ignored, so a choice left over can never touch live covering. Opening the same recording again picks its airing automatically.
- With a replay airing, `/tv/sync` sends the airing id and `pos` (seconds since the recording's start). The server reads that airing's finished breaks from the DB (the in-memory list keeps only the last 6 h, `KEEP_S`) and returns them **as recording positions**: `lead_in + program time` (below), each marked `replay: true`. `content.js` then covers and fast-forwards with the same logic, using `pos` in place of `ref`.
- A chosen recording counts as a replay without the 45-min test (its clock isn't broadcast time, so `now - ref` means nothing there). Live breaks still need the 45-min test.
- The popup shows the choice with a **Clear** link, and its status says `Replay: NBC SNF · Sun Oct 19 · lined up` (or `· not lined up`).

**Lining up: breaks as offsets into the program.** A recording is lined up with **offsets**, not broadcast times (user, 2026-10-26).
- Each break's offset is its **program time**: seconds from the airing's **Program started at** (`break start_ref - airing start_ref`), the same `1:05:03` the review page shows. Not stored as a new column: the DB keeps the broadcast `start_ref`/`end_ref` (live covering needs them), and the offsets are worked out from them, so they can't drift apart.
- Per recording, one more number: **`lead_in`** = how far into the recording the program starts (YouTube TV's padding before it, e.g. 47 s). Stored on the airing (`airings.replay_lead_in_s`, plus `replay_lined_up`). Then a break sits at **recording position = `lead_in` + its program time**, which you can check by eye on the recording's own scrubber against the review page.
- **First guess:** `lead_in = 0` (the recording starts when the program starts). Only good enough for the curtain.
- **Break starts now** button in the TV popup (shown only with a replay airing): pause on the first frame of any commercial break and press it. The server finds the airing's break whose recording position (`lead_in` + program time) is nearest to `pos` (within ±10 min; refuses if none, or if two are about equally near), sets `lead_in = pos - that break's program time`, and saves `lined_up`. Pressing it again at another break re-lines it up. Once per recording, since it's saved. The popup then says e.g. `Lined up: the program starts 0:47 into the recording`.
- **Editing Program started at** on the review page moves every program time by the same amount, so the server moves a lined-up recording's `lead_in` by that amount too and it stays lined up.
- **Until lined up, breaks on a recording get the curtain, never a fast-forward** (a wrong `lead_in` could skip game instead of ad). After the line-up they fast-forward like any replay break.

**Phases:**
1. `page-seek.js`, skip logic and badge for the far-behind case. Test in the harness (fake player whose `seekTo` moves `ref`) on a scratch server copy, then live with `--fake-break` and a TV paused 45+ min (or temporarily lower the threshold for the live check).
2. Recordings: the `kas()` check above, then the **Replay of** dropdown, the DB lookup, the offset and **Break starts now**.
3. README (Behavior notes, Controls) and SPEC (§1, §5.3, §8).

**Decisions** (2026-10-25):
1. Spec rule becomes: **never seek during live events; seeking is OK during replays.** A replay = a recording, or the TV 45+ min behind live; anything closer to live is a live event.
2. Land **4 s before the break end**.
3. "Far behind" = **45+ min behind live** (`now - ref - 20 s`), no detector needed.
4. **Popup checkbox, on by default** (cover mode): "Fast-forward through breaks in replays (45+ min behind)".
5. For a recording, **the TV popup asks which program (airing) from the recorded list** it is.
6. A recording is lined up with **offsets**: each break at its program time (offset from Program started at), plus one stored `lead_in` per recording (where the program starts in it), set with a **Break starts now** button (2026-10-26).
7. On a recording, **curtain until lined up**, fast-forward after (2026-10-26).
