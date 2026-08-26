import * as Cesium from 'cesium';

import { strikeAgeMinutes, strikeStrength } from './fmiLightning.js';

/**
 * Lightning strikes from the Finnish Meteorological Institute.
 *
 * Keyless open data covering Finland and a wide surrounding area -- in testing,
 * Scandinavia through the Baltics into Poland. Strikes are points, coloured by
 * polarity-independent strength and faded by age so a live storm reads as a
 * bright cluster while the tail of the window sits back.
 *
 * STATIC GRAPHICS ONLY, deliberately, following the hard-won lesson recorded in
 * earthquakes.js: no CallbackProperty anywhere. A per-frame property on a few
 * hundred entities re-evaluates every frame for a visual nobody asked for.
 * Age fade is recomputed on each poll instead, which is exactly as often as the
 * data changes.
 *
 * @module data/lightning
 */

const API_URL = '/api/fmi/lightning?hours=24';

/** Hours of history requested; also the window over which age fade runs. */
const WINDOW_MINUTES = 24 * 60;

// Near-white cores with a cool cast, not blue.
//
// The first pass used mid-blues, which disappeared entirely against a dark
// satellite globe over water and forest -- the layer looked broken when it was
// working. Lightning reads as white-hot; the strength difference is carried by
// SIZE, with hue only tinting the weakest.
const STRENGTH_STYLE = Object.freeze({
  strong: { color: Cesium.Color.fromCssColorString('#ffffff'), size: 20 },
  moderate: { color: Cesium.Color.fromCssColorString('#dcf0ff'), size: 14 },
  weak: { color: Cesium.Color.fromCssColorString('#a8d8ff'), size: 10 },
});

/**
 * Opacity from age: fresh strikes at full strength, decaying to a floor rather
 * than to nothing. A strike that fades to invisible leaves the user unable to
 * tell "no data" from "old data", which for a bursty phenomenon is the more
 * confusing of the two.
 *
 * @param {number} ageMinutes
 * @returns {number} 0.25 to 1
 */
export function strikeOpacity(ageMinutes) {
  if (!Number.isFinite(ageMinutes)) return 0.55;
  const fraction = Math.min(1, Math.max(0, ageMinutes / WINDOW_MINUTES));
  // Floor at 0.55, not 0.25. Over a 24h window MOST strikes are old, so a deep
  // floor made the typical case the invisible one and the layer read as empty.
  return 1 - (fraction * 0.45);
}

/**
 * One strike's presentation. Split out so it can be tested without Cesium
 * entity plumbing.
 * @param {{peakCurrentKa: number|null, time: string, cloudToGround: boolean|null}} strike
 * @param {number} nowMs
 * @returns {{size: number, alpha: number, strength: string, outline: boolean}}
 */
export function strikeAppearance(strike, nowMs) {
  const strength = strikeStrength(strike?.peakCurrentKa);
  const style = STRENGTH_STYLE[strength];
  return {
    strength,
    size: style.size,
    alpha: strikeOpacity(strikeAgeMinutes(strike?.time, nowMs)),
    // Ground strikes get an outline: they are the ones that start fires and
    // hit infrastructure, and they are the minority, so they should stand out.
    outline: strike?.cloudToGround === true,
  };
}

/** Human summary for the entity description panel. */
export function describeStrike(strike) {
  const ka = Number.isFinite(strike?.peakCurrentKa) ? `${Math.abs(strike.peakCurrentKa)} kA` : 'current unknown';
  const kind = strike?.cloudToGround === true
    ? 'cloud-to-ground'
    : strike?.cloudToGround === false ? 'cloud-to-cloud' : 'type unknown';
  return `${kind}, ${ka}`;
}

export function createLightningLayer() {
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;

  const layer = {
    id: 'lightning',
    name: 'Lightning (24h)',
    icon: '⚡',
    source: 'FMI',
    updateInterval: 120000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('lightning');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      console.log('[Data:Lightning] Initialized');
    },

    enable() {
      if (_dataSource) _dataSource.show = true;
    },

    disable() {
      if (_dataSource) _dataSource.show = false;
    },

    async update() {
      try {
        const response = await fetch(API_URL);
        if (!response.ok) {
          _lastError = `FMI HTTP ${response.status}`;
          return false;
        }
        const payload = await response.json();
        const strikes = Array.isArray(payload?.strikes) ? payload.strikes : [];

        _dataSource.entities.removeAll();
        const now = Date.now();
        for (const strike of strikes) {
          if (!Number.isFinite(strike?.lat) || !Number.isFinite(strike?.lon)) continue;
          const look = strikeAppearance(strike, now);
          const base = STRENGTH_STYLE[look.strength].color;
          _dataSource.entities.add({
            id: `lightning:${strike.id}`,
            position: Cesium.Cartesian3.fromDegrees(strike.lon, strike.lat),
            point: {
              pixelSize: look.size,
              color: base.withAlpha(look.alpha),
              // Every strike gets a rim -- it is what separates a point from
              // busy terrain behind it. Ground strikes get a heavier one.
              outlineColor: Cesium.Color.fromCssColorString('#4fc3f7').withAlpha(look.alpha),
              outlineWidth: look.outline ? 4 : 2,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            description: describeStrike(strike),
            properties: {
              peakCurrentKa: strike.peakCurrentKa,
              cloudToGround: strike.cloudToGround,
              time: strike.time,
            },
          });
        }

        _count = _dataSource.entities.values.length;
        // Milliseconds, NOT an ISO string: the toggle panel subtracts this to
        // render "3h ago", and a string yields "NaNh ago" -- which reads as a
        // broken layer rather than a fresh one. Matches earthquakes.js.
        _lastUpdate = Date.now();
        _lastError = strikes.length === 0 ? null : null;
        // An empty window is a normal, frequent outcome -- most of the year
        // there is no lightning in range. Logged as a count, never as an error.
        console.log(`[Data:Lightning] ${_count} strikes in the last 24h`);
        return true;
      } catch (error) {
        _lastError = error?.message || 'Lightning fetch failed';
        return false;
      }
    },

    destroy(viewer) {
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const now = Cesium.JulianDate.now();
      const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 2000;
      const out = [];
      for (const entity of _dataSource.entities.values) {
        if (out.length >= limit) break;
        const cartesian = entity.position ? entity.position.getValue(now) : null;
        const carto = cartesian ? Cesium.Cartographic.fromCartesian(cartesian) : null;
        const p = entity.properties;
        out.push({
          id: String(entity.id),
          kind: 'lightning',
          name: describeStrike({
            peakCurrentKa: p?.peakCurrentKa?.getValue(now),
            cloudToGround: p?.cloudToGround?.getValue(now),
          }),
          peakCurrentKa: p?.peakCurrentKa?.getValue(now) ?? null,
          cloudToGround: p?.cloudToGround?.getValue(now) ?? null,
          time: p?.time?.getValue(now) ?? null,
          lat: carto ? Cesium.Math.toDegrees(carto.latitude) : null,
          lon: carto ? Cesium.Math.toDegrees(carto.longitude) : null,
        });
      }
      return out;
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
  return layer;
}

const lightningLayer = createLightningLayer();

export default lightningLayer;
