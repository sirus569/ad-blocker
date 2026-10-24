#!/usr/bin/env bash
# Kid Ad Shield: starts both Chromes on Ubuntu, each on tv.youtube.com.
#   TV Chrome:       your normal profile, hardware acceleration on (goes on the TV).
#   Detector Chrome: its own profile in ~/.chrome-detector, GPU off (stays on the laptop screen).
# Both keep running after this script (and its terminal) exits. Start server.py separately.
# Run: bash app/launch-chromes-ubuntu.sh

URL='https://tv.youtube.com/'
DETECTOR_PROFILE="$HOME/.chrome-detector"

chrome=$(command -v google-chrome || command -v google-chrome-stable)
if [ -z "$chrome" ]; then
  echo "Google Chrome not found. Install it from https://www.google.com/chrome/ (needs 116 or newer)."
  exit 1
fi

# A second launch of an already-running profile only opens a new window in it,
# and the running Chrome keeps the flags it started with.
running=$(pgrep -af -- "--user-data-dir=$DETECTOR_PROFILE")
if [ -n "$running" ] && ! grep -q -- '--disable-gpu' <<<"$running"; then
  echo "WARNING: detector Chrome is already running WITHOUT --disable-gpu, so tab capture"
  echo "         will give black frames. Quit it (all its windows) and run this again."
fi

launch() { setsid "$chrome" "$@" >/dev/null 2>&1 </dev/null & }

launch --new-window "$URL"                                                    # TV
launch --user-data-dir="$DETECTOR_PROFILE" --disable-gpu \
       --no-first-run --no-default-browser-check --new-window "$URL"          # detector

echo "Started TV Chrome and detector Chrome ($chrome)."
if ! (exec 3<>/dev/tcp/127.0.0.1/8787) 2>/dev/null; then
  echo "server.py is not running yet. Start it with:"
  echo "  gnome-session-inhibit --inhibit idle python3 app/server/server.py"
fi
echo
echo "Next:"
echo "  Detector window (popup mode Reporter): keep it on the laptop screen, visible, quality lowest."
echo "    Popup: pick the Program, Start capture."
echo "  TV window (popup mode Cover): drag it to the TV, fullscreen. Popup: Start. Pause ~5 min, then play."
