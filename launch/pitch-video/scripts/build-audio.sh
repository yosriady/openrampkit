#!/usr/bin/env bash
# Builds assets/audio-mix.wav = procedural music bed + licensed SFX (+ voiceover if present).
# Voiceover is picked up automatically from assets/voiceover.mp3 (made by scripts/make-voice.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
DUR=15
node scripts/gen-music.mjs assets/music-bed.wav >/dev/null

VO=assets/voiceover.mp3
MUSIC_VOL=0.55   # bed level without voice
if [[ -f "$VO" ]]; then MUSIC_VOL=0.22; fi   # carve room for the voice

# SFX cue sheet: file|start seconds|volume (synced to beats in index.html)
CUES=(
  "assets/sfx/riser.mp3|1.10|0.18"          # long build that crests on the logo at 11.1 s
  "assets/sfx/whoosh-short.mp3|2.72|0.35"    # hook exits
  "assets/sfx/pop.mp3|3.12|0.30"             # payment chips land
  "assets/sfx/whoosh.mp3|4.28|0.30"          # chips pour into the modal
  "assets/sfx/click.mp3|4.98|0.45"           # Deposit USDC pressed
  "assets/sfx/ping.mp3|5.98|0.30"            # coins land on chains
  "assets/sfx/whoosh-short.mp3|6.78|0.30"    # to proof montage
  "assets/sfx/click-soft.mp3|8.15|0.40"      # screen swap
  "assets/sfx/click-soft.mp3|9.15|0.40"      # screen swap
  "assets/sfx/impact-bass-1.mp3|11.08|0.55"  # logo block lands
  "assets/sfx/sparkle.mp3|11.95|0.28"        # wordmark reveal
)

inputs=(-i assets/music-bed.wav)
filters="[0:a]volume=${MUSIC_VOL}[m];"
labels="[m]"
i=1
for c in "${CUES[@]}"; do
  IFS='|' read -r f t v <<<"$c"
  inputs+=(-i "$f")
  ms=$(awk "BEGIN{printf \"%d\", $t*1000}")
  filters+="[$i:a]aresample=48000,aformat=channel_layouts=stereo,volume=$v,adelay=${ms}|${ms}[s$i];"
  labels+="[s$i]"
  i=$((i+1))
done
if [[ -f "$VO" ]]; then
  # fit the voice into 0.3 s .. 14.7 s: speed it up only if it is too long
  vd=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VO")
  tempo=$(awk "BEGIN{r=$vd/14.2; if (r<1) r=1; printf \"%.4f\", r}")
  inputs+=(-i "$VO")
  filters+="[$i:a]aresample=48000,aformat=channel_layouts=stereo,atempo=$tempo,volume=1.0,adelay=300|300[vo];"
  labels+="[vo]"
  i=$((i+1))
  echo "voiceover: ${vd}s, atempo ${tempo}"
fi
n=$i
filters+="${labels}amix=inputs=$n:normalize=0:duration=first,atrim=0:$DUR,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[out]"
ffmpeg -loglevel error -y "${inputs[@]}" -filter_complex "$filters" -map "[out]" -ac 2 -ar 48000 -t $DUR assets/audio-mix.wav
echo "wrote assets/audio-mix.wav ($(ffprobe -v error -show_entries format=duration -of csv=p=0 assets/audio-mix.wav)s)"
