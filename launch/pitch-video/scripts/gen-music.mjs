#!/usr/bin/env node
// Procedural 15 s music bed for the OpenRampKit pitch. No samples, no third-party audio:
// everything is synthesized here, so the bed is royalty-free by construction.
// Output: 48 kHz stereo 16-bit WAV. Usage: node scripts/gen-music.mjs <out.wav>
import { writeFileSync } from "node:fs";

const SR = 48000;
const DUR = 15.0;
const N = Math.round(SR * DUR);
const L = new Float32Array(N);
const R = new Float32Array(N);

// seeded PRNG (mulberry32) for deterministic noise
let seed = 0x0badc0de;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
const TAU = Math.PI * 2;

// Chord plan, aligned to the four visual beats (hook, rails, proof, lockup).
// A minor tension -> F -> C -> G -> Am -> resolve on F(add9) -> C major for the logo.
const chords = [
  { t: 0.0, notes: [57, 60, 64, 71], bass: 45 }, // Am(add9)
  { t: 3.0, notes: [57, 60, 65, 67], bass: 41 }, // F(add9)
  { t: 5.0, notes: [55, 60, 64, 67], bass: 48 }, // C
  { t: 7.0, notes: [55, 59, 62, 67], bass: 43 }, // G
  { t: 9.0, notes: [57, 60, 64, 69], bass: 45 }, // Am
  { t: 11.0, notes: [57, 60, 65, 69], bass: 41 }, // F
  { t: 12.4, notes: [55, 60, 64, 72], bass: 36 }, // C (resolve)
];
const chordEnd = (i) => (i + 1 < chords.length ? chords[i + 1].t : DUR);

// soft pad: a few detuned harmonics, slow attack, crossfaded release
function pad(freq, t0, t1, amp, pan) {
  const att = 0.35, rel = 0.45;
  const s0 = Math.floor(t0 * SR), s1 = Math.min(N, Math.floor((t1 + rel) * SR));
  for (let s = s0; s < s1; s++) {
    const t = s / SR - t0;
    let env = Math.min(1, t / att);
    if (s / SR > t1) env *= Math.max(0, 1 - (s / SR - t1) / rel);
    let v = 0;
    for (let h = 1; h <= 5; h++) {
      const det = 1 + (h % 2 ? 0.0021 : -0.0017);
      v += Math.sin(TAU * freq * h * det * t + h) / (h * h * 0.9);
    }
    v *= amp * env * (0.85 + 0.15 * Math.sin(TAU * 0.4 * t));
    L[s] += v * (1 - pan);
    R[s] += v * pan;
  }
}
function bass(freq, t0, t1, amp) {
  const s0 = Math.floor(t0 * SR), s1 = Math.min(N, Math.floor((t1 + 0.2) * SR));
  for (let s = s0; s < s1; s++) {
    const t = s / SR - t0;
    let env = Math.min(1, t / 0.08);
    if (s / SR > t1) env *= Math.max(0, 1 - (s / SR - t1) / 0.2);
    const v = amp * env * (Math.sin(TAU * freq * t) + 0.25 * Math.sin(TAU * freq * 2 * t));
    L[s] += v;
    R[s] += v;
  }
}
function kick(t0, amp) {
  const s0 = Math.floor(t0 * SR), len = Math.floor(0.32 * SR);
  let ph = 0;
  for (let i = 0; i < len && s0 + i < N; i++) {
    const t = i / SR;
    const f = 45 + 95 * Math.exp(-t * 28);
    ph += TAU * f / SR;
    const v = amp * Math.sin(ph) * Math.exp(-t * 9);
    L[s0 + i] += v;
    R[s0 + i] += v;
  }
}
function hat(t0, amp, pan) {
  const s0 = Math.floor(t0 * SR), len = Math.floor(0.05 * SR);
  let prev = 0;
  for (let i = 0; i < len && s0 + i < N; i++) {
    const n = rnd() * 2 - 1;
    const hp = n - prev; // crude high-pass
    prev = n;
    const v = amp * hp * Math.exp(-(i / SR) * 90);
    L[s0 + i] += v * (1 - pan);
    R[s0 + i] += v * pan;
  }
}
function bell(freq, t0, amp, pan) {
  const s0 = Math.floor(t0 * SR), len = Math.floor(1.6 * SR);
  for (let i = 0; i < len && s0 + i < N; i++) {
    const t = i / SR;
    const v = amp * Math.exp(-t * 3.2) * (Math.sin(TAU * freq * t) + 0.35 * Math.sin(TAU * freq * 2.76 * t) * Math.exp(-t * 6));
    L[s0 + i] += v * (1 - pan);
    R[s0 + i] += v * pan;
  }
}

chords.forEach((c, i) => {
  const t1 = chordEnd(i);
  c.notes.forEach((m, k) => pad(midi(m), c.t, t1, 0.05, 0.3 + 0.13 * k));
  bass(midi(c.bass), c.t, t1, i === 0 ? 0.06 : 0.1);
});

const BEAT = 0.5; // 120 BPM
// hook: sparse ticking hats build tension
for (let t = 1.0; t < 3.0; t += BEAT / 2) hat(t, 0.05 + 0.03 * (t / 3), 0.65);
// rails + proof: soft four-on-the-floor pulse with offbeat hats
for (let t = 3.0; t < 10.95; t += BEAT) {
  kick(t, 0.38);
  hat(t + BEAT / 2, 0.08, 0.35);
}
// arpeggiated bells over the lockup (C major), echoing the coin rolling up the ramp
[72, 76, 79, 84].forEach((m, i) => bell(midi(m), 11.15 + i * 0.22, 0.09, 0.3 + i * 0.13));
[79, 84].forEach((m, i) => bell(midi(m), 12.45 + i * 0.3, 0.06, 0.6 - i * 0.2));

// gentle master fade in / out
for (let s = 0; s < N; s++) {
  const t = s / SR;
  const g = Math.min(1, t / 0.25) * Math.min(1, (DUR - t) / 1.2);
  L[s] *= g;
  R[s] *= g;
}
// normalize to -3 dBFS peak
let peak = 0;
for (let s = 0; s < N; s++) peak = Math.max(peak, Math.abs(L[s]), Math.abs(R[s]));
const k = 0.708 / (peak || 1);

const out = process.argv[2] || "music-bed.wav";
const buf = Buffer.alloc(44 + N * 4);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + N * 4, 4);
buf.write("WAVE", 8);
buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28);
buf.writeUInt16LE(4, 32);
buf.writeUInt16LE(16, 34);
buf.write("data", 36);
buf.writeUInt32LE(N * 4, 40);
for (let s = 0; s < N; s++) {
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[s] * k)) * 32767), 44 + s * 4);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[s] * k)) * 32767), 46 + s * 4);
}
writeFileSync(out, buf);
console.log(`wrote ${out} (${DUR}s, ${SR} Hz stereo)`);
