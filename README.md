# Kid Ad Shield

Covers the TV and mutes it during commercials in live YouTube TV (and labeled ads on Prime Video). Never skips ads. When unsure, it shows the game.

## How it works

- **Detector Chrome** (laptop screen, muted, ~5 min ahead) watches its own video for the channel logo to disappear and logs each break by content timestamp (YouTube's player reports the same timestamp for the same moment in any window). The detector runs inside the extension, using tab capture; no screen recording.
- **TV Chrome** (on the TV, behind) covers and mutes when the content it's showing falls inside a logged break.
- **`server.py`** (laptop Terminal) connects the two: it stores the breaks and tells each side what it needs. Stop it and the TV uncovers and does nothing.

## Project layout

```
app/                    everything needed to run
  server/               server.py, db.py, review.html, trivia.json, templates/
                        (kid-ad-shield.db and logs/ are created here as it runs)
  extension/            the Chrome extension (load unpacked from here)
  launch-chromes-ubuntu.sh   starts the TV and detector Chromes on Ubuntu
research/               testing and planning, not needed to run
  SPEC.md               design spec and verified facts
  spikes/               throwaway tabCapture test extensions (results in SPEC.md section 3)
  hardware/             hw-check.sh and load-test.py for Ubuntu laptops, results/ = their output
```

Commands below are run from the project folder. `server.py` keeps its files next to itself, so keep everything in `app/server/` together.

## Mac and Ubuntu

Works on both; the server needs only Python 3 and the extension needs Chrome 116+. What differs:

| | Mac | Ubuntu |
|---|---|---|
| Start both Chromes | TV Chrome: open it normally. Detector: `open -na "Google Chrome" --args --user-data-dir="$HOME/.chrome-detector" --disable-gpu` | `bash app/launch-chromes-ubuntu.sh` (opens both on tv.youtube.com; by hand, the detector is `google-chrome --user-data-dir="$HOME/.chrome-detector" --disable-gpu &`) |
| Start the server | `python3 app/server/server.py` | `gnome-session-inhibit --inhibit idle python3 app/server/server.py` |
| Keep the display awake | Automatic: `server.py` runs `caffeinate` | `gnome-session-inhibit` (above) stops the screen from blanking while the server runs. `server.py` alone does not. Or: Settings → Power → Screen Blank → **Never** |
| Two displays | System Settings → Desktop & Dock → "Displays have separate Spaces" **on** | Nothing to set |
| Shortcuts | Option+Shift+K / Option+Shift+D | Alt+Shift+K / Alt+Shift+D |
| Lid | Keep it **open** (clamshell mode moves the detector onto the TV) | Keep it **open** |

Elsewhere in this README, "Option" means Alt on Ubuntu and `python3 app/server/server.py` means the Ubuntu command above.

## One-time setup

1. **Server:** needs only Python 3 (no packages). Run `python3 app/server/server.py` (Ubuntu: see [Mac and Ubuntu](#mac-and-ubuntu)).
2. **Detector Chrome profile:** start it with the command for your system in [Mac and Ubuntu](#mac-and-ubuntu). Sign into YouTube TV in it (skip Chrome sync).
   - **Make it look different:** in the detector Chrome only, open `chrome://settings/manageProfile`, name it **DETECTOR – GPU off** and pick a loud theme color (e.g. red). It stays with that profile, so the TV Chrome keeps the normal look. Tab capture records only the page, not Chrome's toolbar, so this doesn't affect detection.
   - **Check the GPU is off:** open `chrome://gpu` in each Chrome. Detector = "Software only, hardware acceleration unavailable"; TV = "Hardware accelerated". If the detector shows hardware accelerated, it was already running without `--disable-gpu`: quit all its windows and start it again.
3. **Load the extension in both Chromes:** `chrome://extensions` → Developer mode → Load unpacked → `app/extension/`. Pin it. Needs Chrome 116 or newer.
4. **Set modes in the extension popup:** TV Chrome = **Cover**, detector Chrome = **Reporter**.
5. **macOS only:** System Settings → Desktop & Dock → "Displays have separate Spaces" **on**.

## Each time

1. Laptop lid **open**, TV connected.
2. `python3 app/server/server.py` (on Mac it also keeps the display awake; on Ubuntu use the `gnome-session-inhibit` command).
3. Open detector Chrome (command in [Mac and Ubuntu](#mac-and-ubuntu); on Ubuntu `bash app/launch-chromes-ubuntu.sh` opens it and the TV Chrome together) on the laptop screen. Tune to the channel, set quality to the lowest, keep the window visible (never minimized).
4. In the detector Chrome (mode = Reporter), with the YouTube TV tab open and in front, open the extension popup, pick the **Program** from the dropdown (programs you've watched before are listed; choose **New program…** and type a name like `NBC SNF` the first time), then press **Start capture** (the button hides while capture is running and comes back if it stops; pressing it never relearns the logo). A program you've watched before loads its saved logo instantly; a new one learns it in the first ~90 s of normal play. The toolbar badge shows OK when frames are flowing (CLICK means capture isn't running). Redo this if you close the tab.
5. TV Chrome on the TV: same channel. Open the extension popup and press **Start** (the badge shows ON; until then the TV Chrome never contacts the server). Fullscreen, **pause ~5 min** to build the lead, then play. Don't hit "Live".
6. Check the Terminal status line: `detector ✓  tv ✓  lead 4:xx`.

Change channels on the TV only; the detector follows.

## Controls

- **Kill switch:** Ctrl+C on `server.py`. TV uncovers within ~2 s.
- **Start / Stop (TV Chrome popup):** Stop uncovers at once and stops all server contact; Start resumes. It remembers the choice across restarts.
- **Manual cover:** popup buttons **Cover now** / **Uncover now** (TV Chrome), or click the video and press Option+Shift+K. Both work without the server. The shortcut only works when the TV page has keyboard focus, so the buttons are more reliable. **Uncover now** during a detected break dismisses that break for good; during a labeled ad it stays off until that ad's label goes away. In fullscreen, move the mouse to the top of the TV screen to reach the toolbar.
- **Diagnostics:** Option+Shift+D prints ad-looking page elements to the console.
- **Detector debug page:** open from the detector Chrome's popup. Shows the crop, the learned logo mask, the live score, and a **Relearn** button.

## Overlay and trivia

- The cover closes like a curtain over 5 s and opens again so the game is fully back exactly when the break ends (it starts opening 5 s early; the sound comes back at the end). If something goes wrong (server stopped, Stop, Uncover now) it opens in under a second.
- While covered it shows trivia from **`trivia.json`** (in `app/server/`, next to `server.py`): a question, then the answer 15 s later, a new one every 30 s. Questions don't repeat within a game until all of them have been asked, and the last 4 from this game (with answers) sit as cards along the bottom of the cover. Edit the file any time, no restart needed. Format: `[{"q": "Question?", "a": "Answer"}, {"q": "Open-ended question?"}]` (leave out `"a"` for questions with no right answer).

## Logo templates

Learned logos are saved per program in **`app/server/templates/`** (next to `server.py`, one `.json` file each), so next week's game doesn't relearn. Same channel, different show (e.g. NBC's SNF logo vs the regular peacock) = pick a different program name. Delete a file there, or press **Relearn** on the debug page, to start that program over.

## Reviewing breaks (the review page)

Open **http://127.0.0.1:8787/review** while `server.py` is running.

- Pick the **program** (the names from the detector's Program dropdown) and the **airing** (one showing on one date).
- **Program started at:** set this once to the real start of the program (broadcast clock). Every time on the page is then counted from it (`1:05:03` = 1 h 5 min 3 s into the program), so it lines up with a recording that starts when the program starts. Until you set it, it's a guess: the first moment the detector saw (or `--program-start`).
- For each break, mark the **start** and the **end** separately as *OK*, *Too early* or *Too late*, plus how many seconds. Click **What the marks mean** on the page for which way is which.
- **Merge with next** joins two breaks that were really one (the detector split it and the ad showed for a moment). **Unmerge** undoes it; the original breaks and their marks are kept.
- Marks and merges are notes for judging detection; they don't change what the TV covers.
- **Trivia asked during this airing** lists every question shown, with its answer and when it came up (in program time).

Everything is stored in **`kid-ad-shield.db`** (SQLite, in `app/server/` next to `server.py`). An old `breaks.json` is imported once, as per-channel programs. A new airing starts when a program has been quiet on that channel for 3+ hours.

## Reviewing detection (log-only)

To check how good detection is before turning on covering, run:
```
python3 app/server/server.py --log-only
```
(optionally `--program-start 19:30` if you want times counted from when the program began; otherwise 0:00:00 is the first moment the detector reported on the channel.)

- **`app/server/logs/breaks-<time>.log`**: one line when a break opens and one when it closes, e.g. `started -> 1:05:03, ended -> 1:07:23`, plus the broadcast clock time so you can line it up with a recording.
- **`app/server/logs/trace-<time>.csv`**: the logo score for every second. A real break shows scores near 0; use it to see why a break was missed or invented.
- **Detector debug page** (popup in the detector Chrome → *Detector debug*): shows the video, the corner the detector decided holds the logo, the learned logo pixels (red) and the current edges (cyan). If red isn't sitting on the logo, press **Relearn** during normal play.
- Start the detector during normal play, not a commercial: it spends the first ~90 s learning the logo.

## Behavior notes

- Covers from break start until 1.5 s before it ends; max 3 min per break (longer breaks leak their tail).
- The cover shows a countdown, **Back in m:ss**, when the break's end is already known (the usual case with a few minutes of lead), or **Back soon** while it is still being detected. It never counts past the 3-minute cap.
- Breaks under ~15 s aren't covered (to avoid hiding replays).
- First ~90 s on a new channel: learning the logo, no covering. If a commercial was playing during that minute, use Relearn.
- Lead under ~20 s: covering gets less reliable. Pause the TV to rebuild it.
- `python3 app/server/server.py --log-only` detects and prints breaks without covering. Use it for tuning.

## Troubleshooting

| Symptom | Check |
|---|---|
| `tv ✗` | TV tab open on tv.youtube.com? Mode = Cover? Reload tab after extension reloads. |
| `detector ✗` | Detector Chrome open and playing? Mode = Reporter? Badge says OK? If not, click the icon to restart capture. |
| `logo none` / `logo learning` | Wait ~90 s. If it stays `none`, open the debug page and check the mask; try Relearn during normal play. |
| Never covers | Run `server.py --log-only` first and check that breaks are logged; check the debug page shows the video crop. |
| Detector audio on TV | Detector video should auto-mute; mute the tab manually if not. |
| Detector shows on TV | Lid was closed. Open it, move the window back. |
