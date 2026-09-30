#!/usr/bin/env bash
# Generates assets/voiceover.mp3 with ElevenLabs from the VO_TEXT line in voiceover-15s.md.
# Needs ELEVENLABS_API_KEY in launch/media/.env. The key is never printed.
# Optional: ELEVENLABS_VOICE_ID (default: "JBFqnCBsd6RMkjVDRZzb", George), ELEVENLABS_MODEL_ID (default: eleven_multilingual_v2).
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=../media/.env
if [[ -f "$ENV_FILE" ]]; then set -a; . "$ENV_FILE"; set +a; fi
if [[ -z "${ELEVENLABS_API_KEY:-}" ]]; then
  echo "ELEVENLABS_API_KEY is empty in $ENV_FILE. Skipping voiceover." >&2
  exit 1
fi
VOICE="${ELEVENLABS_VOICE_ID:-JBFqnCBsd6RMkjVDRZzb}"
MODEL="${ELEVENLABS_MODEL_ID:-eleven_multilingual_v2}"
TEXT=$(sed -n 's/^VO_TEXT: //p' voiceover-15s.md)
BODY=$(node -e 'console.log(JSON.stringify({text:process.argv[1],model_id:process.argv[2],voice_settings:{stability:0.45,similarity_boost:0.8,style:0.3,use_speaker_boost:true,speed:1.08}}))' "$TEXT" "$MODEL")
curl -sS --fail-with-body -X POST "https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128" \
  -H "xi-api-key: ${ELEVENLABS_API_KEY}" -H "Content-Type: application/json" \
  -d "$BODY" -o assets/voiceover.mp3
echo "wrote assets/voiceover.mp3 ($(ffprobe -v error -show_entries format=duration -of csv=p=0 assets/voiceover.mp3)s)"
