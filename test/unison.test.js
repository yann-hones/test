import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeUnison, lastStrikeStart } from '../js/unison.js';

const SR = 48000;

// Une ou deux cordes de piano (6 partiels inharmoniques, décroissance, bruit).
function strings(f0, list, { dur = 3, B = 0.0004, strikeAt = [0] } = {}) {
  const buf = new Float32Array(SR * dur);
  let seed = 3;
  for (const t0 of strikeAt) {
    for (const { cents, amp, phase } of list) {
      const f = f0 * 2 ** (cents / 1200);
      for (let n = 1; n <= 6; n++) {
        const fn = n * f * Math.sqrt(1 + B * n * n);
        for (let i = Math.round(t0 * SR); i < buf.length; i++) {
          const t = i / SR - t0;
          buf[i] += (amp / n) * Math.exp(-t * (0.6 + 0.3 * n)) * Math.sin(2 * Math.PI * fn * t + phase * n) * Math.min(1, t * 200);
        }
      }
    }
  }
  for (let i = 0; i < buf.length; i++) buf[i] += 0.01 * (((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1);
  return buf;
}

const f0 = 261.63;
const ref = f0 * Math.sqrt(1 + 0.0004);

test('sens de correction de la deuxième corde', () => {
  for (const c of [-6, -3, -1.5, 1.5, 3, 6]) {
    for (const amp of [0.6, 1, 1.6]) {
      const r = analyzeUnison(strings(f0, [{ cents: 0, amp: 1, phase: 0.3 }, { cents: c, amp, phase: 2 }]), SR, ref);
      assert.equal(r.status, c > 0 ? 'high' : 'low', `${c} ¢, amplitude ${amp}`);
      assert.ok(Math.abs(r.cents - c) < 0.6, `${c} ¢ estimé à ${r.cents.toFixed(2)}`);
    }
  }
});

test('une seule corde : pas de battement inventé', () => {
  const r = analyzeUnison(strings(f0, [{ cents: 0, amp: 1, phase: 0 }]), SR, ref);
  assert.ok(r.status === 'unsure' || r.status === 'slow', r.status);
});

test('cordes presque à l’unisson : jamais le mauvais sens', () => {
  for (const c of [-0.3, 0.3]) {
    for (const phase of [0, 2, 4]) {
      const r = analyzeUnison(strings(f0, [{ cents: 0, amp: 1, phase: 0.5 }, { cents: c, amp: 1, phase }]), SR, ref);
      assert.notEqual(r.status, c > 0 ? 'low' : 'high', `${c} ¢ phase ${phase}`);
      if (r.status === 'high' || r.status === 'low') assert.ok(Math.abs(r.cents) < 1.5, `${c} ¢ estimé à ${r.cents}`);
    }
  }
});

test('repère la dernière frappe, pas les creux de battement', () => {
  const two = [{ cents: 0, amp: 1, phase: 0 }, { cents: 15, amp: 1, phase: 0 }];
  assert.ok(lastStrikeStart(strings(880, two), SR) < SR * 0.05);
  const restruck = strings(f0, [{ cents: 0, amp: 1, phase: 0 }], { strikeAt: [0, 1.5] });
  assert.ok(Math.abs(lastStrikeStart(restruck, SR) - 1.5 * SR) < 0.03 * SR);
});
