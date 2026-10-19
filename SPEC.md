# Kid Ad Shield: live YouTube TV commercial cover (spec)

Spec for building the next version of Kid Ad Shield. The existing code (Chrome extension v1.2.1 in `kid-ad-shield/` and the old server as `server-old.py`) is included alongside this file. Read this whole spec before starting; section 9 is the build order.

## 1. Goal and hard constraints

Cover the TV screen and mute the sound during commercial breaks in **live** YouTube TV (live sports), automatically, on a Mac.

- **Local only.** Everything runs on one Mac. The server binds to `127.0.0.1` only.
- **Never skip, block, seek past, or speed up ads.** Cover and mute only. Never set `video.currentTime` or `playbackRate`, and **never call the YouTube player's `seekTo`, `seekBy`, `seekToLiveHead`, `seekToStreamTime`, `requestSeekToWallTimeSeconds`, `initiateUnifiedSeek`, or any other seek method.** Read-only use of the player API only.
- **Err on leaking the ad, never cut off the game.** Every tunable and every failure mode must fail toward *not covering*. A few seconds of ad showing is acceptable; hiding live play is not.
- **Kill switch = stop `server.py`.** If the server is unreachable, the TV extension uncovers and does nothing automatic.
- **No phone remote.** The old phone remote (`remote.html`, `/set`, the `remote` override in `content.js`) is removed entirely.
- Prime Video support from v1.2.1 (label-based detection) stays, but is also gated by the kill switch (see 5.4).
- **Scope (user decision): one channel per session.** The user watches sports on a single channel and does not change channels mid-session. Channel following (`follow_channel`) exists and was harness-tested, but channel changes within a session are not a supported use case and need no further testing; on a channel change the detector simply resets.

## 2. Background: why this design

- Live YouTube TV commercial breaks are part of the broadcast feed. The player does not label them; its ad UI (`ytu-ads-title-tray`) stays hidden. Page-based detection cannot see them.
- DRM: with Chrome hardware acceleration ON, screenshots of the video are black. With it OFF, screenshots capture the video, but playback is too laggy to watch. `chrome.tabCapture` also returns real frames with GPU OFF (verified, section 3), so the detector runs inside the extension and needs no screen capture.
- Solution: two Chrome instances on the same channel.
  - **TV Chrome** (normal, hardware acceleration on, smooth) plays on the TV, deliberately **behind** live.
  - **Detector Chrome** (separate profile, GPU off, low quality, muted) runs on the laptop's own screen, **ahead** of the TV.
  - The detector (an offscreen document in the extension, fed by `chrome.tabCapture`) finds breaks by watching for the channel logo to disappear, and records them as **content timestamps**. The TV covers when the content it is showing falls inside a recorded break.

## 3. Verified facts (from manual tests on the target Mac)

### The sync key: `getMediaReferenceTime()`

YouTube TV uses YouTube's standard player script (`base.js`). The player element (`.html5-video-player`) exposes a read-only API. `player.getMediaReferenceTime()` returns the **Unix timestamp (seconds, float) of the content currently shown**. It is the same for the same content in any player, regardless of when that player was loaded.

| Fact | Evidence |
|---|---|
| `getMediaReferenceTime()` matches across players loaded at different times | Two windows loaded ~15 min apart, both at live: values 0.28 s apart, while their `video.currentTime` values were ~855 s apart |
| It tracks content position, not wall clock | After pausing one window ~30 s, its value was 33.6 s behind the other (30 s pause + 2.5 s pre-existing gap), adjusted to the same instant |
| At live it reads ~18–20 s behind the wall clock (broadcast latency) | Both windows |
| `getProgressState().ingestionTime` equals `getMediaReferenceTime()`; `getProgressState().isAtLiveHead` / `player.isAtLiveHead()` correctly report whether the player is at live | Both windows (paused one reported `false`) |
| Player `getCurrentTime()` (stream time) = `video.currentTime` + `getProgressState().offset`, and is also shared across loads | Offset difference (851.65 s) exactly matched the `video.currentTime` gap |

### `video.currentTime` is NOT usable for sync

| Fact | Evidence |
|---|---|
| Every fresh load at live starts at `video.currentTime` ≈ 46,800 with ≈ 3,560–3,600 s to `video.duration` (≈ 50,390) | Four loads across ~1.5 hours |
| So `video.currentTime` depends on when the player loaded; players loaded at different times disagree by roughly the time between loads | Third-window test |
| (Within one load, `video.currentTime` advances smoothly through program changes) | Logs |

### Other

| Fact | Evidence |
|---|---|
| OS screenshots capture the video when Chrome GPU is disabled | Cmd+Shift+3 test |
| `chrome.tabCapture` returns real video frames of the YouTube TV tab in the GPU-off detector Chrome (popup test, `tabcapture-test/`) | Canvas showed moving picture, non-flat stddev |
| Offscreen-document capture (`tabcapture-spike/`) started by one toolbar click delivers real frames with no popup open, unfocused, for 9+ min (`track=live`, moving picture, `sd` 22-94, `still=0`) | Spike log |
| Capture survives a **full navigation** of the tab (`chrome.tabs.update`): one ~0.5 s blank-frame blip (`STATE OK->BLK->OK`), then the same stream continues (sample counter and uptime unbroken, `track=live`). Only same-URL navigation was tested | Spike log, 14:49:56 |
| Closing the tab ends the track (`track ENDED`); the offscreen document keeps ticking on the last frame (`sd=0`, `track=ended`). Reopening the stream needs a new toolbar click (new `START`), after which frames resume | Spike log, 14:47:06 and 14:47:59 |
| Minimizing the detector window did not flip the state to `STILL`/`BLK` or end the track in the spike log (exact minimize time/duration not recorded) | Spike log; treat as "not proven harmful", keep the `capture_ok` guard |
| Capture size is the full tab viewport at device resolution (3840x2486 on this Mac) | Spike log |
| `tabCapture` captures the whole tab viewport, not just the video | Test canvas; so the video's viewport rect is needed to crop |
| YouTube TV page has `ytu-ads-title-tray` with `.ad-sponsored-text` and `.remaining-duration`, visible only for YouTube-inserted ads (not live broadcast breaks) | Diagnostic dump |

## 4. Open questions (handle as described; do not block on them)

1. **What a running player does ~1 h after load** (when `video.currentTime` reaches `video.duration`). Probably a reload or window refresh. **Irrelevant to sync** because the design uses `getMediaReferenceTime()`. The extension must simply survive it: re-find the player element and video each tick, and treat a missing player as "no reading" (don't cover on stale values).
2. **Frame-exact alignment.** `getMediaReferenceTime()` agreed to 0.28 s between players at the same content. Support a per-channel `offset_s` config value (default 0) applied to break times anyway.
3. **Capture robustness. RESOLVED (spike passed).** Offscreen capture works with no popup, unfocused, and survives a full tab navigation (so `follow_channel` needs no extra click; only a same-URL navigation was tested, confirm with a real channel change in step 4). Capture still needs one toolbar click after the detector Chrome launches and after the tab is closed/reopened (`track ENDED`). The reporter must never trust stale frames: after `track ENDED` the offscreen doc keeps drawing the last frame, so `capture_ok` requires `track.readyState === 'live'` (see 5.5). The badge shows `CLICK` when capture is not running.

## 5. Components

### 5.1 Shared concepts

- **Channel ID:** the `<id>` in `https://tv.youtube.com/watch/<id>`.
- **`ref`:** `player.getMediaReferenceTime()`, Unix seconds of the content on screen. The only timeline used for breaks, lead, and cover decisions.
- **Player element:** `document.querySelector('.html5-video-player') || document.querySelector('#movie_player')`. Re-query every tick; it can be replaced on reload or channel change.
- **Break:** `{id, channel, start_ref, end_ref | null, confirmed_at}`. `end_ref == null` means *open* (start confirmed, end not yet).
- **Lead:** `detector_ref - tv_ref`, in seconds.

### 5.2 `server.py` (one process, Python standard library only)

- `ThreadingHTTPServer` on `127.0.0.1:8787`. Shared state behind one lock. No detector code and no third-party dependencies: it only stores state and breaks and serves them.
- Starts `caffeinate -d` as a child process on launch and terminates it on exit (keeps the laptop display awake).
- Persists breaks to `breaks.json` next to the script (write on change, load on start; drop entries whose `start_ref` is more than 6 h behind the detector's latest reported `ref`).
- Prints one status line every 5 s, e.g. `detector ✓ ch=92H17SFrmxw logo ok  tv ✓ ch=92H17SFrmxw  lead 4:40  breaks 3 (1 open)`. Mark a part `✗` when its heartbeat is older than 3 s (the detector is also `✗` when it reports `capture_ok: false`). `logo` shows the detector's `logo` field (`learning`, `ok`, `none`). Add `TV AT LIVE (no lead)` when the TV reports `at_live` true, and `channel mismatch` when channels differ.
- CORS headers are not needed (only the extension service worker calls it, and it has host permission), but harmless to keep.

**Endpoints**

`POST /detector/report`
```json
{"channel": "92H17SFrmxw", "ref": 1792224415.09, "at_live": true, "paused": false, "wall": 1792224433.0,
 "capture_ok": true, "logo": "ok"}
```
`wall` is `Date.now()/1000` when the probe was read. `capture_ok` is true only while the capture track is `live`, tab-capture frames have arrived in the last 3 s, and the player reading is fresh. `logo` is `learning`, `ok`, or `none`.
Response: `{"ok": true, "follow_channel": "<tv channel or null>"}`. `follow_channel` is the TV's current channel when it differs from the detector's (5.3).

`POST /detector/break`
```json
{"key": "k-8f3a", "channel": "92H17SFrmxw", "start_ref": 1792225410.0, "end_ref": null}
```
Upsert by the client-chosen `key` (idempotent): the detector sends it when a break opens (`end_ref: null`) and again with `end_ref` when it closes. Reject (`ok: false`) if `end_ref` is not after `start_ref`. An open break is discarded once the detector's reported `ref` passes `start_ref + 240 s` (the close POST was lost). Response: `{"ok": true, "id": 8}`. Breaks are stored but `/tv/sync` ignores them in `--log-only` mode.

`GET /tv/sync?channel=<id>&ref=<float>&at_live=<0|1>&paused=<0|1>`
Response:
```json
{"ok": true, "detector_alive": true,
 "breaks": [{"id": 7, "start": 1792224600.0, "end": 1792224780.0}, {"id": 8, "start": 1792225410.0, "end": null}]}
```
Only breaks for that channel, with `offset_s` applied, limited to breaks that end after `ref - 60` (or are open). `detector_alive` = detector report within the last 10 s, its latest `capture_ok` is true, **and** the detector's channel equals the requested `channel` (a detector on another channel proves nothing about this one).

`POST /detector/trace`: `{"channel", "thr", "baseline", "rows": [[ref, score, present], ...]}`, per-second logo scores. Appended to `logs/trace-<session>.csv`.

`GET /health` → `{"ok": true}` (for manual checks).

**Review logs (for judging detection quality against a recording).** Each break the detector sends is also appended to `logs/breaks-<session>.log`, one line when it opens and one when it closes, e.g. `ch=ABC break 3 started -> 1:05:03, ended -> 1:07:23 (length 0:02:20, broadcast clock 20:05:03 - 20:07:23)`. Program time is H:MM:SS counted from `--program-start HH:MM[:SS]` (local time of day the program began) or, by default, from the first position the detector reported on that channel in this server session. The broadcast clock time of the content is always logged too, so lines can be aligned with any recording. The trace CSV has `program_time,broadcast_clock,ref,score,present` per second plus `#` lines giving the threshold and baseline.

### 5.3 Chrome extension (one codebase, two modes)

Load the same unpacked extension in both Chrome instances. A **mode** setting (`cover` or `reporter`) chooses the behavior. The default on a fresh install is `cover`.

- **Store `mode` and `enabled` in `chrome.storage.local`, not `sync`.** `sync` would copy the mode between instances signed into the same Google account. `message` and `debug` can stay in `sync`.
- Popup: mode selector, enabled toggle, message, debug toggle. Popup text says which mode is active.
- `manifest.json`: matches `amazon.com`, `primevideo.com`, `tv.youtube.com`; host permission `http://127.0.0.1:8787/*`; keep `storage`; add `tabCapture`, `activeTab`, `offscreen`. Minimum Chrome version 111 (for `"world": "MAIN"`).
- `background.js` stays the only place that does network I/O (Chrome blocks web pages from reaching localhost). Every fetch uses an `AbortController` timeout of **1000 ms**.
- Remove all phone-remote code (`remote`, `pollRemote`, `/state`, `/set`, `/report`).

**Reading `ref`: requires a MAIN-world script.** The player API methods are attached to the element by YouTube's own page JavaScript. Content scripts run in an isolated world and **cannot see them**. Add a second content script for `tv.youtube.com` with `"world": "MAIN"` (`page-probe.js`) that every 250 ms:
- finds the player element and the main `<video>`;
- reads `getMediaReferenceTime()`, `isAtLiveHead()`, `video.paused`, the video's `getBoundingClientRect()` (viewport coordinates, used to crop captured frames), `window.innerWidth/innerHeight`, and `Date.now()/1000` as `wall`;
- wraps each call in try/catch; if the API is missing or throws, sends `ref: null`;
- dispatches `window.dispatchEvent(new CustomEvent('kas-probe', {detail}))`.

`content.js` (isolated world) listens for `kas-probe` and treats a probe older than 1 s, or `ref: null`, as **no reading**. The MAIN-world script only reads; it never calls seek methods or modifies the page.

**Reporter mode** (detector Chrome):
- Never covers. Sets `video.muted = true` on every video, every tick (both Chromes play through the same HDMI output).
- Every 500 ms, POST `/detector/report` from the latest probe, plus `capture_ok` and `logo` from the offscreen detector (5.5).
- `content.js` forwards each probe to the offscreen document (via `chrome.runtime` messages) so frames can be mapped to `ref`.
- **Starting capture:** `chrome.tabCapture` needs a user gesture, so the user opens the popup on the YouTube TV tab after launching the detector Chrome and presses **Start capture**. The popup (the user gesture) calls `chrome.tabCapture.getMediaStreamId({targetTabId})` and sends the id to `background.js`, which creates the offscreen document (reason `USER_MEDIA`) and remembers the captured tab id. The popup also shows capture status (frame signals, probe). `background.js` merges the offscreen document's health into every report: `capture_ok` is true only if the state is fresh, the player reading exists, and the report comes from the captured tab. The toolbar badge shows `OK` or `CLICK` (capture not running). Until capture is running, the reporter sends `capture_ok: false`.
- If the response has `follow_channel`, navigate to `https://tv.youtube.com/watch/<follow_channel>`. Debounce: at most once per 10 s, kept in `sessionStorage` (a navigation wipes memory, so an in-memory debounce could loop). Navigate with `location.assign`; accept only ids matching `^[\w-]+$`.

**Cover mode** (TV Chrome):
- **Start/Stop** (popup button, `running` in `storage.local`, default stopped): while stopped the TV Chrome sends no requests at all and does no automatic covering (manual Option+Shift+K still works); Stop uncovers immediately. Toolbar badge `ON` while running. Harness-tested on an isolated port: 0 syncs while stopped, covers after Start, uncovers and unmutes within 50 ms of Stop, no syncs after.
- Every 500 ms, GET `/tv/sync` with the latest probe. Cache the break list.
- **Health:** 3 consecutive failed syncs (timeout or error) = server down. Pages with no probe (Prime Video) poll `GET /health` every 500 ms instead of `/tv/sync`, with the same 3-failure rule. Then: clear cached breaks, uncover and unmute immediately, and disable all automatic covering (including label detection) until a sync succeeds again.
- **Cover decision every 250 ms, local only** (no network in this path), using the latest probe's `ref`, advanced by elapsed time since the probe if playing. With **no reading**, break-based covering is off. Cover if any of:
  - Confirmed break: `start + START_DELAY <= ref < end - END_EARLY`
  - Open break: `ref >= start + START_DELAY` **and** `detector_alive` is true. If the detector goes stale, uncover.
  - Label detection (existing `AD_SELECTORS` / player text scan) hits, and the server is healthy.
  - Manual cover is on: Option+Shift+K, or the popup's **Cover now** button. Manual works even with the server down.
- **Popup Cover now / Uncover now** (cover mode): the popup messages the active tab's content script (`kas-cover-now`, `kas-uncover-now`, `kas-state`) and shows whether the screen is covered and why. Added because Option+Shift+K only works when the page has keyboard focus. *Uncover now* turns manual off, suppresses the break being covered (like the max-cover cap), and dismisses a labeled-ad cover until the label disappears. Harness-tested on an isolated port; the popup click path itself is only testable in real Chrome.
- **Max cover:** if covered continuously by the same break for **180 s**, uncover and do not re-cover that break ID. (Decided: keep 180 s even though breaks longer than that will leak their tail.)
- Constants (top of `content.js`): `START_DELAY = 0.0`, `END_EARLY = 1.5`, `MAX_COVER_S = 180`. Positive values only ever shrink the covered span.
- While covered, re-mute immediately on any `volumechange` that un-mutes a video (YouTube's player sometimes un-mutes on its own; waiting for the 250 ms tick let blips of sound through). Tested: re-mute in 0.3-5 ms; after uncovering, sound returns and a viewer's own mute is left alone.
- **Countdown on the overlay** (break covers only): `Back in m:ss` = `min(end - END_EARLY - ref, MAX_COVER_S - covered_so_far)` when the break's end is known, `Back soon` while it is open; manual and label covers show no countdown. Harness-tested: matches the true time left (rounded up) and is limited by the 180 s cap.
- (A "partial cover" option that inset the overlay 10% per side was tried and removed at the user's request: awkward in use. Use Uncover now to check the screen instead.)
- Keep the existing overlay, mute logic (only unmute videos we muted), fullscreen handling, Option+Shift+D dump, and `kidAdShieldDump()`.

### 5.4 Prime Video / labeled ads

Unchanged detection from v1.2.1, including the YouTube TV ad-tray selectors. Gated by server health like everything else (the user chose a single kill switch: no server = no automatic covering anywhere).

### 5.5 Detector (in the extension, JavaScript)

Runs only in reporter mode, in an **offscreen document** (`offscreen.html` / `offscreen.js`) fed by `chrome.tabCapture`. Plain canvas pixel math; no libraries. The server never sees frames; it only receives breaks via `POST /detector/break`.

**Frames.** The capture stream plays in a hidden `<video>`. At 4 fps, draw it to a canvas and crop to the **picture**, downscaled to 480 px wide. The `<video>` element can be larger than the picture (black bars when the window is not 16:9; real case: a wide, short detector window), so the probe also reports the video's intrinsic size (`vw`, `vh`) and the crop is the element's rect shrunk to that aspect ratio and centered (`object-fit: contain`). That rect is in page pixels. **The capture stream is not always the tab's shape** (real setup: a 3440x1440 stream for a ~16:9 tab): Chrome fits the tab inside the stream, centered, with black filling the rest. So page px map to stream px with one uniform scale `k = min(streamW/innerW, streamH/innerH)` plus the centering offset. (The first version scaled x and y separately, which put black bars inside every crop and let the bar edge be learned as the logo.) Corners are the picture's corners, never the bars. **Found on the first real run:** cropping to the element let the detector learn a persistent edge in the black bars as the "logo", so it never saw a break. Recompute it every frame (the player can resize). Timestamp each frame with `Date.now()/1000`.

**Map frame time → `ref`.** From the most recent probe `p` forwarded by `content.js`: `ref_at = p.ref + (t - p.wall)` if not paused, else `p.ref`. Ignore frames if the latest probe is older than 2 s or has `ref: null`. `capture_ok` is true only while the capture track's `readyState` is `live`, frames are arriving (last frame < 3 s old), and the probe is fresh. After `track ENDED` the video element keeps showing the last frame, so never infer health from the frame content alone.

**Frames to discard.** Skip (do not count as present or absent) any frame whose overall brightness spread is near zero (`sd < 2`, a blank frame such as the ~0.5 s blip after a navigation) or while the probe has `ref: null`. A blank frame must never read as "logo absent".

**Capture resolution.** The stream arrives at full viewport device resolution (3840x2486 in the spike). Do **not** constrain the stream size yet: a max-size constraint might letterbox the viewport and break the crop mapping. Downscale to ~480 px wide before any pixel work; measure CPU in step 5 and only then consider a constraint (and verify the mapping if so).

**Logo learning (per channel, automatic).**
- Consider the four corner regions (each ~25% width × 25% height of the cropped video).
- Convert to grayscale and compute a Sobel gradient magnitude, thresholded relative to the frame's mean gradient into a binary edge map.
- Over the first ~90 s of a channel, count per pixel how often it is an edge. (Periodic refresh from "logo present" frames is not implemented; use Relearn.) The logo is the set of pixels that are edges in ≥ ~90% of frames, forming a dense cluster in one corner.
- Store the mask and reference edge map per channel in `chrome.storage.local` via `background.js` (**offscreen documents only have `chrome.runtime`**: calling `chrome.storage` there threw, which broke Relearn and left learning half-finished on the first real runs) (key `logo2:<channel>`; the old `logo:` key held masks learned on the wrong crop and is ignored) so restarts don't relearn.
- If no corner has a clear stable region, set `logo: none`, log it, and do not detect on that channel (fail toward not covering). While learning, `logo: learning` and nothing is detected.
- Learning is automatic, but the debug view shows the learned mask over the frame and has a **Relearn** button (clears the stored mask for the current channel and restarts the 90 s window). Use it if the first minute of a channel happened to be a commercial or the mask landed on the wrong thing.

**Per-frame score.** Fraction of mask pixels that are edges in the current corner (edge overlap). Bin into 1 s buckets by `ref`; take the median score per second. `present = score >= threshold` (start ~0.5 × the learned baseline; tune).

**Hindsight segmentation.** Using the lead, decide with context:
- Open a break when the logo is absent for **≥ 15 consecutive seconds**. `start_ref` = first absent second.
- Close it when the logo is present for **≥ 3 consecutive seconds**. `end_ref` = first present second.
- Discard any absence shorter than 15 s (replays, graphics).
- Send the open break (`end_ref: null`) to the server as soon as it opens, then again with `end_ref` when it closes. Use a client-generated `key` per break. Network I/O goes through `background.js`. If the server is unreachable the break is dropped (fails toward not covering).
- Ignore frames while the detector is paused. If `ref` jumps by more than 5 s vs expected (seek, reload), reset the in-progress segment.

**Debug view.** A `Detector debug` page (opened from the popup) shows the latest cropped frame, the learned mask overlay, the live score and threshold, recent breaks, and the Relearn button. This replaces the old `--debug-capture`. Debug output stays in the extension; nothing is written to disk.

**Log-only mode.** `server.py --log-only`: the server still stores breaks and prints a line each time one opens or closes (with the time and `ref`), but `/tv/sync` returns none. Used for tuning before covering is turned on.

## 5.6 Target channels

The user watches **FOX, CBS, NBC, ABC** (live sports). That the logo disappears during commercials on each of these is an assumption, not yet verified. Step 5 acceptance is per network: for each, confirm the learned mask lands on the logo and logged breaks match observed commercial breaks. A network where it does not work gets `logo: none` and no covering.

## 6. Display and process setup (target environment)

- MacBook, lid **open**, external TV over HDMI. Clamshell mode would move the detector onto the TV.
- System Settings → Desktop & Dock → "Displays have separate Spaces" **on**.
- TV Chrome: normal profile, fullscreen on the TV display.
- Detector Chrome: `open -na "Google Chrome" --args --user-data-dir="$HOME/.chrome-detector" --disable-gpu`, on the laptop screen, windowed (never minimized), not fully covered by other windows, quality set to lowest. After launching it and tuning to a channel, click the extension icon on the YouTube TV tab once and press "Start capture" (5.3).
- Terminal with `server.py` on the laptop screen. No Screen Recording permission or Python dependencies are needed.
- YouTube TV uses 2 concurrent streams for this setup.

## 7. Failure behavior (all must fail toward not covering)

| Failure | Behavior |
|---|---|
| `server.py` stopped / crashed | TV uncovers within ~1.5 s, goes idle; manual cover still works |
| Detector Chrome closed or stalled, or tab capture not running / frames stopped (`capture_ok: false`) | Confirmed breaks still used; open breaks uncover; status shows `detector ✗` |
| Detector window minimized or fully occluded and frames freeze | Same as above (`capture_ok` goes false within ~3 s) |
| Detector tab closed/reopened | Track ends, `capture_ok: false`, badge `CLICK`, open breaks uncover; resume after one toolbar click |
| Player API missing / `ref` unavailable on the TV | No break-based covering; label detection still works if the server is up |
| Player reloads (e.g. ~1 h after load) | Brief "no reading"; resumes with correct `ref` automatically |
| Logo not learned for a channel (`logo: none` / `learning`) | No breaks logged for it |
| Break POST fails (server down) | Break dropped; nothing covers |
| Cover exceeds 180 s | Uncover; never re-cover that break |
| TV catches up to the detector (lead < ~20 s) | Open-break rule covers; status line shows the small lead |
| TV at live (no lead) | Status line warns; detection can't run ahead, so expect leaks |
| Extension reloaded | Content script orphaned; tab reload required (existing behavior, log it) |

## 8. Non-goals

Phone remote; LAN access; cloud anything; skipping or seeking past ads; Prime Video live-stream detection (separate effort); audio-based detection.

## 9. Build order and acceptance tests

1. **`tabCapture` feasibility test. DONE.** Real frames in the GPU-off detector Chrome (throwaway extension in `tabcapture-test/`). Decision: the detector runs in the extension; server has no detector code.
1b. **Offscreen capture spike. DONE** (`tabcapture-spike/`). Passed: no popup, unfocused 9+ min of live frames, full-navigation survival (0.5 s blank blip), tab-close ends the track, minimize not proven harmful. Results in section 3.
2. **Server core.** New `server.py`: endpoints, state, `breaks.json`, status line, `caffeinate`, `127.0.0.1` only, `POST /detector/break`, `--log-only`. Test with `curl`. Add a `--fake-break START_REF END_REF CHANNEL` flag for testing (also accept `+N` meaning N seconds after the TV's first reported `ref`, `open` as END for an open break, and `tv` as CHANNEL for whatever channel the TV is on; the flag can repeat). Per-channel `offset_s` comes from an optional `config.json` next to the script: `{"offset_s": {"ABC": 0.0}}`. **DONE and tested with curl** (endpoints, validation, persistence, `--log-only`, stuck-open-break discard, `follow_channel`, status line, clean Ctrl+C/`kill` including `caffeinate`).
3. **Extension cover mode + MAIN-world probe.** Modes in `storage.local`, probe → `ref`, `/tv/sync`, health rule, cover decision, max cover, phone-remote removal. **Accept:** a fake break covers and uncovers at the right `ref` (± 0.5 s); pausing the TV delays the cover by the pause length; `Ctrl+C` on the server uncovers within 2 s.
   **Built; verified in a harness, not yet in real Chrome.** A test page with a fake player (`getMediaReferenceTime()`) loaded the real `content.js`, `page-probe.js`, `background.js` against the real `server.py`. Results: a confirmed break covered at +10.00 s and uncovered at +28.50 s of content time for a 10-30 break with `END_EARLY` 1.5 (exact); pausing the player for 15 s delayed the cover by exactly 15 s of wall time; killing the server mid-cover uncovered in 1.28 s; an open break did not cover without a live detector, covered ~0.3 s after one appeared, and uncovered ~10 s after it went silent. **Live check by the user in the TV Chrome (real YouTube TV player, unpacked extension): all step 3 tests passed** (probe on the real player, fake-break cover/uncover, pause test, kill switch). Still untested: the 180 s cap and label detection on real pages.
4. **Extension reporter mode + capture plumbing.** *(Built. Harness-verified against the real server: reports at 2/s with correct channel and `ref`, never covers, stays muted, `capture_ok` false shows `detector ✗`, and follows the TV's channel within ~1 s. Verified in real Chrome: popup Start capture works and reports `Capture OK (3440x2214; frames: rvfc 0, time 564, count 574; probe ok)`, so on the hidden capture video `requestVideoFrameCallback` never fires (removed) while `currentTime` and `getVideoPlaybackQuality().totalVideoFrames` both advance (kept). Detector now reaches the server in real Chrome. Found along the way: the `enabled` setting also gates reporting, so a disabled reporter sends nothing while capture and the badge still look healthy; the popup checkbox is now labeled "Enabled" and warns when off. Still to verify live: lead display and pause test, channel follow, tab-close recovery.)* Reports, auto-mute, channel following, offscreen document with `tabCapture` started from the popup, probe forwarding, `capture_ok`. **Accept:** status line shows both players and a lead that changes by exactly the TV's pause length; changing channel on the TV moves the detector within ~10 s; capture keeps running through a real channel change (follow_channel); closing the detector tab flips the status to `detector ✗` within 3 s and clicking the icon on the reopened tab resumes it.
5. **Detector, log-only.** *(Built. Harness-verified with a synthetic broadcast through the real `offscreen.js`, `background.js` and `server.py`: learned the corner logo (968 mask pixels, baseline 0.99), opened a break 0.2 s after the true start and closed it 0.2 s after the true end, and the server wrote the break log and trace. Timing constants were shortened for the harness only. First real-stream run failed (learned a border edge in the black bars, no breaks detected); fixed by cropping to the picture. The harness now reproduces a pillarboxed capture with a decoy edge at the border: it learns the logo, and a break opens and closes within 0.24 s of the true times. Second real run: the crop still included bars (the page probe in the open YouTube TV tab had not been reloaded, so it was not reporting the video size), and the learner again chose a line along the border. Added: logo pixels must be at least 3 crop px from the picture border, a 1% inset on the crop, and a geometry readout plus warnings on the debug page. The harness, now with a decoy line hugging the picture border, learns only the logo and detects the break within 0.4 s. Third real run (CBS): picture and logo found, five breaks logged, but the crop was 480x197 instead of 16:9 because the stream was letterboxed; fixed with the uniform-scale mapping, harness reproduces a letterboxed stream and gives a 480x270 crop with breaks within 0.03 s. **Fourth real run (CBS, NFL): working.** Crop `480x270` from the 3440x1440 stream with offset `464,0`; the learned mask traces only the "CBS SPORTS" logo; a 95 s break (11:32:31 -> 11:34:06 broadcast clock) matched a real commercial break and ended right as the broadcast returned (user-observed). Next: a full game in log-only mode, compared against real break times, to measure misses and false breaks (e.g. long replays or full-screen graphics) before step 6.)* Crop, logo learning, scoring, hindsight, `POST /detector/break`. **Accept:** the debug view's crop matches the video and the learned mask sits on the logo; over a live game, logged breaks match observed commercial breaks; no breaks logged during play.
6. **Turn on covering.** Tune thresholds on real games.

Version the extension `2.0.0`. Keep code small and commented; no build tooling (plain JS, plain Python stdlib).
