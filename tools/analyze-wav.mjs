// Analyse un enregistrement .wav avec le moteur de l'appli (vérification à distance).
// Usage : node tools/analyze-wav.mjs fichier.wav [touche 1-88] [--a4=440] [--unisson=Hz]
import { readFileSync } from 'node:fs';
import { detectPitch, measurePeak, fitInharmonicity, rms } from '../js/pitch.js';
import { analyzeUnison, lastStrikeStart } from '../js/unison.js';
import { keyName, nearestKey, equalFreq, cents, railsbackCents, defaultPartial, inharmonicRatio } from '../js/tuning.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && a.endsWith('.wav'));
const keyArg = args.find((a) => /^\d+$/.test(a));
const opt = (name, d) => Number(args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? d);
const a4 = opt('a4', 440);

function readWav(path) {
  const b = readFileSync(path);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 12;
  let fmt = null;
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4);
    const size = v.getUint32(off + 4, true);
    if (id === 'fmt ') fmt = { channels: v.getUint16(off + 10, true), sr: v.getUint32(off + 12, true), bits: v.getUint16(off + 22, true), format: v.getUint16(off + 8, true) };
    if (id === 'data') {
      const bytes = fmt.bits / 8;
      const frames = Math.floor(size / (bytes * fmt.channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < fmt.channels; c++) {
          const p = off + 8 + (i * fmt.channels + c) * bytes;
          s += fmt.format === 3 ? v.getFloat32(p, true) : bytes === 2 ? v.getInt16(p, true) / 32768 : bytes === 3 ? ((v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getInt8(p + 2) << 16)) / 8388608) : v.getInt32(p, true) / 2147483648;
        }
        out[i] = s / fmt.channels;
      }
      return { sr: fmt.sr, data: out };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('fichier WAV illisible');
}

const { sr, data } = readWav(file);
const strike = lastStrikeStart(data, sr);
console.log(`${file} : ${(data.length / sr).toFixed(2)} s à ${sr} Hz, niveau RMS ${rms(data).toFixed(4)}, dernière frappe à ${(strike / sr).toFixed(2)} s`);

// Fenêtre d'analyse : 0,68 s commençant 0,3 s après la dernière frappe (ou la fin du fichier).
const start = Math.min(data.length - 32768, strike + Math.round(0.3 * sr));
const win = data.subarray(Math.max(0, start), Math.max(0, start) + 32768);
const p = detectPitch(win, sr, { size: 8192 });
const key = keyArg ? Number(keyArg) : p ? nearestKey(p.freq, a4) : null;
console.log(`hauteur détectée : ${p ? `${p.freq.toFixed(2)} Hz (netteté ${p.clarity.toFixed(2)}) → ${keyName(nearestKey(p.freq, a4))}` : 'aucune'}`);
if (!key) process.exit(0);

const ref = equalFreq(key, a4);
const parts = [];
let B = 0;
for (let n = 1; n <= 8; n++) {
  const f = n * ref * inharmonicRatio(n, B) * 2 ** (railsbackCents(key) / 1200);
  if (f > Math.min(12000, sr / 2.2)) break;
  const m = measurePeak(win, sr, f, { rangeCents: n === 1 ? 90 : 50 });
  if (m.strength > 0.03) {
    parts.push({ n, freq: m.freq, strength: m.strength });
    const fit = fitInharmonicity(parts);
    if (fit && fit.B > 0 && fit.B < 0.05) B = fit.B;
  }
}
const fit = fitInharmonicity(parts);
const n = defaultPartial(key);
const used = parts.find((q) => q.n === n) || parts[0];
const f1 = used ? used.freq / (used.n * inharmonicRatio(used.n, fit?.B ?? 0)) : null;
console.log(`note ${keyName(key)} (touche ${key}), La4 = ${a4} Hz`);
if (f1) {
  console.log(`fondamental ${f1.toFixed(3)} Hz : ${cents(f1, ref).toFixed(2)} ¢ / tempérament égal, ${(cents(f1, ref) - railsbackCents(key)).toFixed(2)} ¢ / cible étirée (partiel ${used.n})`);
}
console.log(`inharmonicité B = ${fit ? fit.B.toExponential(2) : '–'}`);
for (const q of parts) {
  console.log(`  partiel ${q.n} : ${q.freq.toFixed(2)} Hz, force ${q.strength.toFixed(2)}, écart à n×f1 ${f1 ? cents(q.freq, q.n * f1).toFixed(1) : '–'} ¢`);
}
const uni = opt('unisson', 0);
if (uni) {
  const r = analyzeUnison(data, sr, uni, { fundamental: f1 ?? uni });
  console.log('unisson :', r);
}
