#!/usr/bin/env bash
# Generate one ElevenLabs voiceover clip per line in demo-lines.json.
# Usage: bash launch/media/scripts/tts.sh [--force]
# Reads ELEVENLABS_API_KEY from launch/media/.env. The key is never printed.
# Writes launch/media/.vo/<id>.mp3 and launch/media/.vo/durations.json.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
VOICE_ID="${VOICE_ID:-EXAVITQu4vr4xnSDxMaL}" # Sarah (ElevenLabs premade voice)
MODEL_ID="${MODEL_ID:-eleven_multilingual_v2}"
mkdir -p .vo
FORCE="${1:-}"
node -e 'for (const l of require("./scripts/demo-lines.json")) console.log(l.id + "\t" + l.text)' |
while IFS=$'\t' read -r id text; do
  out=".vo/$id.mp3"
  if [[ -s "$out" && "$FORCE" != "--force" ]]; then continue; fi
  body=$(node -e 'console.log(JSON.stringify({ text: process.argv[1], model_id: process.argv[2], voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true } }))' "$text" "$MODEL_ID")
  code=$(curl -s -o "$out" -w '%{http_code}' -X POST \
    "https://api.elevenlabs.io/v1/text-to-speech/$VOICE_ID?output_format=mp3_44100_128" \
    -H "xi-api-key: $ELEVENLABS_API_KEY" -H 'Content-Type: application/json' -d "$body")
  if [[ "$code" != "200" ]]; then echo "TTS failed for $id: HTTP $code"; cat "$out"; rm -f "$out"; exit 1; fi
  echo "ok $id"
done
node -e '
const { execFileSync } = require("child_process")
const d = {}
for (const l of require("./scripts/demo-lines.json")) {
  d[l.id] = +execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `.vo/${l.id}.mp3`]).toString().trim()
}
require("fs").writeFileSync(".vo/durations.json", JSON.stringify(d, null, 2))
console.log(d, "total", Object.values(d).reduce((a, b) => a + b, 0).toFixed(1))
'
