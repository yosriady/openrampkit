#!/usr/bin/env bash
# Mix the voiceover clips onto the recorded demo and encode the final files.
# Inputs: demo-raw.webm and .vo/marks.json (record-demo.mjs), .vo/<id>.mp3 and .vo/durations.json (tts.sh).
# Outputs: demo-final-hq.mp4 (high quality) and demo-final.mp4 (under 10 MB for upload).
set -euo pipefail
cd "$(dirname "$0")/.."
LEAD="${LEAD:-0.25}"     # seconds between a beat start and its voice line
OFFSET="${OFFSET:-0}"    # video time minus mark time (measured near 0 for Playwright video)
LEN=$(node -e 'const m=require("./.vo/marks.json"); console.log(Math.min(m.end, 150).toFixed(2))')

# Place each clip at its beat with adelay. Speed up a clip (atempo up to 1.15) only if it overruns the next beat.
FILTER=$(node -e '
const m = require("./.vo/marks.json"), d = require("./.vo/durations.json"), lines = require("./scripts/demo-lines.json")
const lead = +process.argv[1], off = +process.argv[2], len = +process.argv[3]
const ids = lines.map((l) => l.id)
const parts = [], outs = []
ids.forEach((id, i) => {
  const at = m[id] + off + lead
  const next = i + 1 < ids.length ? m[ids[i + 1]] + off + lead : len
  const slot = next - at - 0.15
  let tempo = d[id] > slot ? Math.min(1.15, d[id] / slot) : 1
  if (d[id] / tempo > slot) console.error(`warning: ${id} overruns by ${(d[id] / tempo - slot).toFixed(2)}s`)
  const ms = Math.round(at * 1000)
  parts.push(`[${i + 1}:a]aresample=48000,${tempo > 1 ? `atempo=${tempo.toFixed(3)},` : ""}adelay=${ms}|${ms}[v${i}]`)
  outs.push(`[v${i}]`)
})
parts.push(`${outs.join("")}amix=inputs=${ids.length}:normalize=0:dropout_transition=0,apad,atrim=0:${len},afade=t=out:st=${(len - 0.6).toFixed(2)}:d=0.6[vo]`)
console.log(parts.join(";"))
' "$LEAD" "$OFFSET" "$LEN")
INPUTS=()
for id in $(node -e 'for (const l of require("./scripts/demo-lines.json")) console.log(l.id)'); do INPUTS+=(-i ".vo/$id.mp3"); done

# Voice track, then two-pass loudness normalisation to -16 LUFS.
ffmpeg -v error -y -f lavfi -i anullsrc=r=48000:cl=stereo -t "$LEN" "${INPUTS[@]}" -filter_complex "$FILTER" -map "[vo]" -c:a pcm_s16le .vo/voice-raw.wav
STATS=$(ffmpeg -hide_banner -i .vo/voice-raw.wav -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null - 2>&1 | sed -n '/^{/,/^}/p')
read -r MI MTP MLRA MTH MOFF < <(node -e 'const s=JSON.parse(process.argv[1]); console.log(s.input_i, s.input_tp, s.input_lra, s.input_thresh, s.target_offset)' "$STATS")
ffmpeg -v error -y -i .vo/voice-raw.wav -af "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=$MI:measured_TP=$MTP:measured_LRA=$MLRA:measured_thresh=$MTH:offset=$MOFF:linear=true,aresample=48000" -c:a pcm_s16le .vo/voice.wav

VF="trim=start=$OFFSET:duration=$LEN,setpts=PTS-STARTPTS,fade=t=out:st=$(node -e "console.log(($LEN-0.6).toFixed(2))"):d=0.6,format=yuv420p"
# High quality
ffmpeg -v error -y -i demo-raw.webm -i .vo/voice.wav -filter_complex "[0:v]$VF[v]" -map "[v]" -map 1:a \
  -c:v libx264 -preset slow -crf 18 -r 25 -c:a aac -b:a 192k -movflags +faststart -t "$LEN" demo-final-hq.mp4
# Upload copy: two-pass at a fixed bitrate so it stays under 10 MB.
VB="${VB:-380k}"
ffmpeg -v error -y -i demo-raw.webm -filter_complex "[0:v]$VF[v]" -map "[v]" -c:v libx264 -preset slow -b:v "$VB" -r 25 -pass 1 -passlogfile .vo/x264 -an -f mp4 /dev/null
ffmpeg -v error -y -i demo-raw.webm -i .vo/voice.wav -filter_complex "[0:v]$VF[v]" -map "[v]" -map 1:a \
  -c:v libx264 -preset slow -b:v "$VB" -r 25 -pass 2 -passlogfile .vo/x264 -c:a aac -b:a 96k -movflags +faststart -t "$LEN" demo-final.mp4
for f in demo-final-hq.mp4 demo-final.mp4; do
  printf '%s  %s s  %s bytes\n' "$f" "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")" "$(stat -f %z "$f")"
done
ffmpeg -hide_banner -i demo-final.mp4 -af ebur128 -f null - 2>&1 | grep -E '^\s+I:' | tail -1
