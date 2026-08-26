import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFmiLightning, strikeAgeMinutes, strikeStrength } from './fmiLightning.js';

// Verbatim shape from opendata.fmi.fi, trimmed to two strikes.
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<wfs:FeatureCollection numberReturned="6">
<wfs:member><BsWfs:BsWfsElement>
 <BsWfs:Location><gml:Point><gml:pos>53.41790 22.80890</gml:pos></gml:Point></BsWfs:Location>
 <BsWfs:Time>2026-08-25T12:14:24Z</BsWfs:Time>
 <BsWfs:ParameterName>multiplicity</BsWfs:ParameterName>
 <BsWfs:ParameterValue>1</BsWfs:ParameterValue>
</BsWfs:BsWfsElement></wfs:member>
<wfs:member><BsWfs:BsWfsElement>
 <BsWfs:Location><gml:Point><gml:pos>53.41790 22.80890</gml:pos></gml:Point></BsWfs:Location>
 <BsWfs:Time>2026-08-25T12:14:24Z</BsWfs:Time>
 <BsWfs:ParameterName>peak_current</BsWfs:ParameterName>
 <BsWfs:ParameterValue>40</BsWfs:ParameterValue>
</BsWfs:BsWfsElement></wfs:member>
<wfs:member><BsWfs:BsWfsElement>
 <BsWfs:Location><gml:Point><gml:pos>53.41790 22.80890</gml:pos></gml:Point></BsWfs:Location>
 <BsWfs:Time>2026-08-25T12:14:24Z</BsWfs:Time>
 <BsWfs:ParameterName>cloud_indicator</BsWfs:ParameterName>
 <BsWfs:ParameterValue>0</BsWfs:ParameterValue>
</BsWfs:BsWfsElement></wfs:member>
<wfs:member><BsWfs:BsWfsElement>
 <BsWfs:Location><gml:Point><gml:pos>61.50000 25.00000</gml:pos></gml:Point></BsWfs:Location>
 <BsWfs:Time>2026-08-25T13:00:00Z</BsWfs:Time>
 <BsWfs:ParameterName>peak_current</BsWfs:ParameterName>
 <BsWfs:ParameterValue>-120</BsWfs:ParameterValue>
</BsWfs:BsWfsElement></wfs:member>
<wfs:member><BsWfs:BsWfsElement>
 <BsWfs:Location><gml:Point><gml:pos>61.50000 25.00000</gml:pos></gml:Point></BsWfs:Location>
 <BsWfs:Time>2026-08-25T13:00:00Z</BsWfs:Time>
 <BsWfs:ParameterName>cloud_indicator</BsWfs:ParameterName>
 <BsWfs:ParameterValue>1</BsWfs:ParameterValue>
</BsWfs:BsWfsElement></wfs:member>
<wfs:member><BsWfs:BsWfsElement>
 <BsWfs:Location><gml:Point><gml:pos>61.50000 25.00000</gml:pos></gml:Point></BsWfs:Location>
 <BsWfs:Time>2026-08-25T13:00:00Z</BsWfs:Time>
 <BsWfs:ParameterName>multiplicity</BsWfs:ParameterName>
 <BsWfs:ParameterValue>NaN</BsWfs:ParameterValue>
</BsWfs:BsWfsElement></wfs:member>
</wfs:FeatureCollection>`;

test('members are grouped into strikes, not counted as strikes', () => {
  // THE bug this parser exists to avoid: FMI emits one member per PARAMETER,
  // so six members here are two strikes. Counting members reports triple.
  const strikes = parseFmiLightning(XML);
  assert.equal(strikes.length, 2);
});

test('a strike carries every parameter that shared its position and time', () => {
  const [first] = parseFmiLightning(XML);
  assert.equal(first.lat, 53.4179);
  assert.equal(first.lon, 22.8089);
  assert.equal(first.time, '2026-08-25T12:14:24Z');
  assert.equal(first.peakCurrentKa, 40);
  assert.equal(first.multiplicity, 1);
  assert.equal(first.cloudToGround, true);
});

test('gml:pos is read as lat/lon, not lon/lat', () => {
  // EPSG:4326 axis order. Reversing it silently puts Finnish strikes in Somalia.
  const [, second] = parseFmiLightning(XML);
  assert.equal(second.lat, 61.5);
  assert.equal(second.lon, 25);
});

test('cloud_indicator 1 is a cloud flash, not a ground strike', () => {
  const [, second] = parseFmiLightning(XML);
  assert.equal(second.cloudToGround, false);
});

test('a NaN parameter stays null rather than becoming zero', () => {
  // FMI writes NaN for missing. Coercing that to 0 would invent a measurement.
  const [, second] = parseFmiLightning(XML);
  assert.equal(second.multiplicity, null);
});

test('negative peak current is preserved — most flashes are negative', () => {
  const [, second] = parseFmiLightning(XML);
  assert.equal(second.peakCurrentKa, -120);
});

test('an empty or malformed response yields no strikes rather than throwing', () => {
  assert.deepEqual(parseFmiLightning(''), []);
  assert.deepEqual(parseFmiLightning(null), []);
  assert.deepEqual(parseFmiLightning('<wfs:FeatureCollection numberReturned="0"/>'), []);
  assert.deepEqual(parseFmiLightning('<wfs:member>garbage</wfs:member>'), []);
});

test('strength bands read from the ABSOLUTE current', () => {
  // Sign is polarity, not magnitude: -120 kA is a strong strike.
  assert.equal(strikeStrength(-120), 'strong');
  assert.equal(strikeStrength(80), 'strong');
  assert.equal(strikeStrength(-40), 'moderate');
  assert.equal(strikeStrength(10), 'weak');
  assert.equal(strikeStrength(null), 'weak');
});

test('age is minutes, and unparseable time is infinitely old', () => {
  const now = Date.parse('2026-08-25T13:00:00Z');
  assert.equal(strikeAgeMinutes('2026-08-25T12:30:00Z', now), 30);
  assert.equal(strikeAgeMinutes('not a date', now), Infinity);
});
