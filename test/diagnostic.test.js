import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smoothB, curveFromB, summarize, tuningOrder, buildPlan, defaultB } from '../js/diagnostic.js';
import { railsbackCents } from '../js/tuning.js';

test('ordre d’accord : La4, octave du milieu, aigus, graves', () => {
  const o = tuningOrder();
  assert.equal(o.length, 88);
  assert.equal(new Set(o).size, 88);
  assert.deepEqual(o.slice(0, 3), [49, 37, 38]);
  assert.equal(o[13], 50);
  assert.equal(o.at(-1), 1);
});

test('courbe calculée : étirée vers l’aigu et le grave, plus forte si les cordes sont raides', () => {
  const B = smoothB({});
  const c = curveFromB(B);
  assert.equal(c[49], 0);
  assert.ok(c[88] > 5 && c[88] < 45, `aigu ${c[88]}`);
  assert.ok(c[1] < -3 && c[1] > -40, `grave ${c[1]}`);
  for (let k = 50; k <= 88; k++) assert.ok(c[k] >= c[k - 12] - 1e-9);
  const stiff = curveFromB(B.map((b) => b * 3));
  assert.ok(stiff[88] > c[88]);
});

test('lissage de B : suit les mesures et comble les trous', () => {
  const measured = {};
  for (let k = 40; k <= 60; k += 2) measured[k] = defaultB(k) * 2;
  const B = smoothB(measured);
  assert.ok(Math.abs(B[50] / defaultB(50) - 2) < 0.01);
  assert.ok(Math.abs(B[10] / defaultB(10) - 2) < 0.01); // trou : rapport global
});

test('diagnostic d’un piano trop bas de 30 ¢', () => {
  const measured = {};
  for (let k = 1; k <= 88; k++) measured[k] = railsbackCents(k) - 30 + ((k * 7) % 5) - 2;
  measured[45] += 25; // une note très fausse
  const s = summarize(measured);
  assert.ok(Math.abs(s.level + 30) < 2, `niveau ${s.level}`);
  assert.equal(s.recommended, 'keep');
  assert.equal(s.options.a440.passes, 2);
  assert.equal(s.options.keep.passes, 1);
  assert.ok(Math.abs(s.options.keep.a4 - 440 * 2 ** (-30 / 1200)) < 0.5);
  assert.equal(s.outliers[0].key, 45);
  assert.ok(!s.risky);
});

test('plan avec remise au diapason : sur-tension à la première passe seulement', () => {
  const dev = { 49: -30, 50: -20, 51: 10 };
  const plan = buildPlan(dev, 0, 2);
  assert.equal(plan.steps.length, 176);
  const first = plan.steps.find((s) => s.key === 49 && s.pass === 1);
  assert.equal(first.overpull, 7.5);
  assert.equal(plan.steps.find((s) => s.key === 51 && s.pass === 1).overpull, -2.5);
  assert.ok(plan.steps.filter((s) => s.pass === 2).every((s) => s.overpull === 0));
  assert.ok(buildPlan({ 49: -200 }, 0, 2).steps[0].overpull === 15);
});
