import assert from 'node:assert/strict';
import test from 'node:test';

import { describeStrike, strikeOpacity } from './lightning.js';

test('old strikes stay clearly visible rather than fading toward nothing', () => {
  // The first pass floored at 0.25, which over a 24h window made the TYPICAL
  // strike invisible against a dark satellite globe -- the layer looked broken
  // while working correctly.
  assert.equal(strikeOpacity(0), 1);
  const dayOld = strikeOpacity(24 * 60);
  assert.ok(dayOld >= 0.55, `oldest strike should stay legible, got ${dayOld}`);
  assert.ok(strikeOpacity(60) > strikeOpacity(12 * 60), 'fresher must be brighter');
});

test('an unparseable age is shown, not hidden', () => {
  assert.ok(strikeOpacity(Infinity) >= 0.5);
});

test('a strike describes its type and current for the info panel', () => {
  assert.equal(describeStrike({ cloudToGround: true, peakCurrentKa: -120 }), 'cloud-to-ground, 120 kA');
  assert.equal(describeStrike({ cloudToGround: false, peakCurrentKa: 12 }), 'cloud-to-cloud, 12 kA');
  assert.equal(describeStrike({}), 'type unknown, current unknown');
});
