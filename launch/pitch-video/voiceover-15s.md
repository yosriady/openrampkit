# OpenRampKit pitch voiceover (15 s)

Optional voiceover for `pitch-15s.mp4`. 33 words. Read fast and confident, about 140 words per minute. The voice starts at 0.3 s.

| Approx. voice time | Picture under it | Voiceover |
| --- | --- | --- |
| 0.3 to 4.0 s | Hook, then the payment chips fly in | Billions want onchain. Most can't pay with a card. |
| 4.0 to 7.5 s | Chips pour into one modal | OpenRampKit: one component for cards, bank transfers and local QR rails. |
| 7.5 to 10.5 s | USDC lands on chain badges, then the real UI montage | Stablecoins land on Arbitrum, Base, Solana and more. |
| 10.5 to 14.5 s | "10 providers" line, then logo lockup and GitHub URL | Ten providers. Open source, self-hosted. |

The voice runs about half a beat behind the picture. That is intentional: the picture leads, the voice confirms. `scripts/build-audio.sh` speeds the voice up (atempo) only if the TTS file is longer than 14.2 s, so it always ends before 14.7 s.

## Script (plain text for TTS)

VO_TEXT below is what `scripts/make-voice.sh` sends to ElevenLabs. Keep it in sync with the table.

VO_TEXT: Billions want onchain. Most can't pay with a card. OpenRampKit: one component for cards, bank transfers and local QR rails. Stablecoins land on Arbitrum, Base, Solana and more. Ten providers. Open source, self-hosted.
