import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch, measurePeak, fitInharmonicity } from '../js/pitch.js';
import { cents } from '../js/tuning.js';

const SR = 48000;

// Note de piano synthétique : partiels inharmoniques décroissants + bruit.
function pianoTone(f0, { B = 0, partials = 8, length = 32768, noise = 0.01, fundamental = 1 } = {}) {
  const buf = new Float32Array(length);
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let n = 1; n <= partials; n++) {
    const fn = n * f0 * Math.sqrt(1 + B * n * n);
    if (fn > SR / 2) break;
    const a = (n === 1 ? fundamental : 1) / n;
    const ph = n * 1.3;
    for (let i = 0; i < length; i++) buf[i] += a * Math.sin((2 * Math.PI * fn * i) / SR + ph);
  }
  for (let i = 0; i < length; i++) buf[i] += noise * rand();
  return buf;
}

test('détection de hauteur sur tout le clavier', () => {
  for (const f of [55, 110, 261.63, 440, 880, 2093]) {
    const r = detectPitch(pianoTone(f, { B: 0.0004 }), SR);
    assert.ok(r, `pas de détection à ${f} Hz`);
    assert.ok(Math.abs(cents(r.freq, f)) < 15, `${f} Hz détecté à ${r.freq}`);
  }
});

test('détection du La0 malgré un fondamental faible', () => {
  const r = detectPitch(pianoTone(27.5, { fundamental: 0.1, partials: 12 }), SR);
  assert.ok(Math.abs(cents(r.freq, 27.5)) < 20, `détecté ${r.freq}`);
});

test('mesure fine d’un partiel au dixième de cent', () => {
  for (const f of [110, 440.37, 1760, 4186]) {
    const buf = pianoTone(f, { partials: 1, noise: 0.02 });
    const r = measurePeak(buf, SR, f * 2 ** (25 / 1200));
    assert.ok(Math.abs(cents(r.freq, f)) < 0.1, `${f} Hz mesuré à ${r.freq} (${cents(r.freq, f)} c)`);
    assert.ok(r.strength > 0.9, `force ${r.strength}`);
  }
});

test('estimation de l’inharmonicité', () => {
  const f0 = 130.81;
  const B = 0.0008;
  const buf = pianoTone(f0, { B });
  const parts = [];
  for (let n = 1; n <= 6; n++) {
    const fn = n * f0 * Math.sqrt(1 + B * n * n);
    parts.push({ n, freq: measurePeak(buf, SR, fn * 1.002).freq });
  }
  const fit = fitInharmonicity(parts);
  assert.ok(Math.abs(fit.B - B) / B < 0.05, `B estimé ${fit.B}`);
  assert.ok(Math.abs(cents(fit.f0, f0)) < 0.2);
});

test('pas de partiel dans la zone : mesure signalée comme collée au bord', () => {
  const buf = pianoTone(110, { partials: 1, noise: 0 });
  assert.equal(measurePeak(buf, SR, 110).edge, false);
  // 150 ¢ au-dessus du seul partiel : le maximum se trouve au bord bas de la zone (±70 ¢)
  assert.equal(measurePeak(buf, SR, 110 * 2 ** (150 / 1200)).edge, true);
});
