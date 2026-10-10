import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  keyName, equalFreq, targetFreq, nearestKey, railsbackCents, isBlackKey, cents, TEMPERAMENTS,
} from '../js/tuning.js';

test('noms des touches', () => {
  assert.equal(keyName(1), 'La0');
  assert.equal(keyName(49), 'La4');
  assert.equal(keyName(40), 'Do4');
  assert.equal(keyName(88, 'en'), 'C8');
  assert.ok(isBlackKey(2));
  assert.ok(!isBlackKey(40));
});

test('fréquences en tempérament égal', () => {
  assert.equal(equalFreq(49), 440);
  assert.ok(Math.abs(equalFreq(40) - 261.6256) < 1e-3);
  assert.ok(Math.abs(equalFreq(1) - 27.5) < 1e-9);
  assert.equal(equalFreq(49, 442), 442);
  assert.equal(nearestKey(261), 40);
  assert.equal(nearestKey(10), 1);
});

test('courbe de Railsback', () => {
  assert.equal(railsbackCents(49), 0);
  assert.ok(Math.abs(railsbackCents(88) - 32) < 1e-9);
  assert.ok(Math.abs(railsbackCents(1) + 28) < 1e-9);
  assert.equal(railsbackCents(88, 0), 0);
  for (let k = 50; k <= 88; k++) assert.ok(railsbackCents(k) >= railsbackCents(k - 1));
});

test('cible avec étirement et tempérament', () => {
  assert.equal(targetFreq(49, { a4: 440, stretch: 1 }), 440);
  assert.ok(Math.abs(cents(targetFreq(88, { stretch: 1 }), equalFreq(88)) - 32) < 1e-9);
  for (const t of Object.values(TEMPERAMENTS)) assert.equal(t.offsets[9], 0);
  const c4 = targetFreq(40, { temperament: 'werckmeister3', stretch: 0 });
  assert.ok(Math.abs(cents(c4, equalFreq(40)) - 11.7) < 1e-9);
});
