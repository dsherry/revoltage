#!/usr/bin/env bash
# Opens Revoltage in Chrome with background throttling off, so the output window keeps drawing while
# it's covered, in another Space or not frontmost (screen sharing in Google Meet, NDI capture).
# Chrome only reads these switches when it starts, so it has to be fully quit first.
# Usage: npm run chrome [-- URL]   (default http://localhost:5173, where both dev and show serve)
set -euo pipefail

URL="${1:-http://localhost:5173}"
SWITCHES=(
  --disable-backgrounding-occluded-windows # covered or off-Space windows keep rendering
  --disable-renderer-backgrounding         # background pages keep full priority
  --disable-background-timer-throttling    # timers in hidden pages aren't slowed to 1 Hz
)

if pgrep -xq "Google Chrome"; then
  read -r -p "Chrome must quit to pick up the switches (a Meet call in Chrome will drop). Quit it now? [y/N] " ok
  if [[ ! "$ok" =~ ^[Yy]$ ]]; then
    echo "Not launched. Quit Chrome (Cmd+Q), then run this again."
    exit 1
  fi
  osascript -e 'quit app "Google Chrome"'
  for _ in $(seq 50); do
    pgrep -xq "Google Chrome" || break
    sleep 0.2
  done
  if pgrep -xq "Google Chrome"; then
    echo "Chrome didn't quit. Quit it yourself, then run this again."
    exit 1
  fi
fi

open -a "Google Chrome" --args "${SWITCHES[@]}" "$URL"
echo "Chrome opened with background throttling off. To confirm: chrome://version, under Command Line."
