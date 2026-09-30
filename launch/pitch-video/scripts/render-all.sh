#!/usr/bin/env bash
# Rebuilds audio (picks up assets/voiceover.mp3 if present), regenerates the vertical cut,
# checks both, renders both, and verifies the 15.0 s duration.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=../media
./scripts/build-audio.sh
./scripts/make-vertical.sh
npx hyperframes check
npx hyperframes check vertical
npx hyperframes render --quality delivery --output "$OUT/pitch-15s.mp4"
if [[ "${SKIP_VERTICAL:-0}" != "1" ]]; then
  npx hyperframes render vertical --quality delivery --output "$OUT/pitch-15s-vertical.mp4"
fi
for f in "$OUT/pitch-15s.mp4" "$OUT/pitch-15s-vertical.mp4"; do
  [[ -f "$f" ]] && echo "$f: $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f") s"
done
