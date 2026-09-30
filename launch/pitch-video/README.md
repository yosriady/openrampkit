# OpenRampKit 15 s pitch video (HyperFrames)

A design-led kinetic pitch, 15.0 s, 30 fps. It is built with [HyperFrames](https://github.com/heygen-com/hyperframes) (HTML in, video out). Node 22+ and FFmpeg are required.

Outputs (in `launch/media/`):

- `pitch-15s.mp4`: 1920x1080
- `pitch-15s-vertical.mp4`: 1080x1920
- `pitch-15s-beat1.png` to `pitch-15s-beat4.png`: one still for each beat

## Beats

| Time | Beat | What is on screen |
| --- | --- | --- |
| 0 to 3 s | Hook | "Billions want onchain." A mint strike line goes through "a card" in "Most can't pay with a card." |
| 3 to 7 s | One component (the key moment) | Chips for VietQR, QRIS, PromptPay, Pix, UPI and Card fly in, then pour into one Deposit modal. The modal says "Planner picks 1 of 10". "Deposit USDC" is pressed. A USDC coin rides a wire and splits onto Arbitrum, Base, Solana and Tempo, plus "+ more chains". |
| 7 to 11 s | Proof | Real playground UI in a phone frame: VietQR (Vietnam), then QRIS (Indonesia), then the withdraw payout (Thailand). Behind the phone, the explorer shows the OpenRampSettlement Settled event on Arbitrum Sepolia. On the left: "10 providers. One component. Self-hosted." Below that: "Deposits and withdrawals. AI agents top up via MCP pay links." |
| 11 to 15 s | Lockup | The logo mark builds (block, then ramp, then the coin rolls up the ramp). Then the wordmark, the tagline, "Open source · MIT" and github.com/yosriady/openrampkit. |

Brand: navy `#10163A`, mint `#2BE3A0`. Type: Archivo Black (display) and JetBrains Mono (labels). The renderer bundles both fonts.

## Files

- `index.html`: the composition. There is one paused GSAP timeline, and all timing uses `data-*` attributes. This file is the source of truth.
- `vertical/index.html`: generated from `index.html` by `scripts/make-vertical.sh`. Do not edit it. The layout switches on `#root[data-width="1080"]`.
- `assets/`: UI crops from `launch/media/frame-*.png`, the logo SVGs, SFX, and the audio mix.
- `scripts/gen-music.mjs`: the procedural music bed (synthesized in code, so it has no licence restrictions).
- `scripts/build-audio.sh`: mixes the music bed, the SFX cues and the voiceover (if present) into `assets/audio-mix.wav`. The SFX cue sheet is in this script.
- `scripts/make-voice.sh`: ElevenLabs TTS. It reads `VO_TEXT` from `voiceover-15s.md`.
- `scripts/render-all.sh`: builds the audio and the vertical file, checks both, renders both, and prints the durations.
- `voiceover-15s.md`: the 33-word voiceover script with timing.

## Audio

- Music: a procedural bed from `scripts/gen-music.mjs`. It follows the beats: A minor tension, a 120 BPM pulse from 3 s to 11 s, and a C major resolve with bells on the logo. No HeyGen, Gemini (Lyria) or MusicGen provider was available, so the bed is synthesized locally.
- SFX: from the HyperFrames `media-use` bundled library, under the Pixabay Content License (see `assets/sfx/CREDITS.md`).
- The mix is normalized for web playback (about -14 LUFS integrated).

## Render (no voice)

```bash
cd launch/pitch-video
./scripts/render-all.sh
```

## Re-render with voiceover (ElevenLabs)

1. Put the key in `launch/media/.env`:

   ```
   ELEVENLABS_API_KEY=...
   ```

   Optional: `ELEVENLABS_VOICE_ID` (default George, `JBFqnCBsd6RMkjVDRZzb`) and `ELEVENLABS_MODEL_ID` (default `eleven_multilingual_v2`).

2. Run:

   ```bash
   cd launch/pitch-video
   ./scripts/make-voice.sh && ./scripts/render-all.sh
   ```

`make-voice.sh` writes `assets/voiceover.mp3`. `build-audio.sh` then finds it and does these steps:

- It lowers the music bed from 0.55 to 0.22.
- It starts the voice at 0.3 s.
- It speeds the voice up only if the voice is longer than 14.2 s.

To go back to the version without voice, delete `assets/voiceover.mp3` and run `./scripts/render-all.sh` again.

## Edit loop

```bash
npx hyperframes preview            # Studio preview of the horizontal cut
npx hyperframes lint
npx hyperframes check              # then: npx hyperframes check vertical
npx hyperframes snapshot --at 1.5,5.5,9.5,13.5
```

The remaining lint warnings are about structure (one file instead of sub-compositions) and the contrast of the decorative ghost word "ONCHAIN". Both are intentional.
