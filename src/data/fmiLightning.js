/**
 * Parse FMI's lightning observations out of WFS "simple feature" XML.
 *
 * The Finnish Meteorological Institute publishes strike detections openly and
 * keylessly (the old fmi-apikey requirement is gone), and the network reaches
 * well beyond Finland -- Baltic states, Poland and Scandinavia all appear.
 *
 * THE SHAPE THAT MATTERS: one strike is NOT one member. The simple-feature
 * format emits a separate <wfs:member> per PARAMETER, all sharing the same
 * position and timestamp:
 *
 *   member 1: pos=53.41790 22.80890  time=...T12:14:24Z  multiplicity=1
 *   member 2: pos=53.41790 22.80890  time=...T12:14:24Z  peak_current=40
 *   member 3: pos=53.41790 22.80890  time=...T12:14:24Z  cloud_indicator=0
 *
 * So 156 members is ~52 strikes, and anything that counts members reports
 * three times the real strike count. Grouping by (position, time) is the whole
 * job here.
 *
 * Parsed with regex rather than a DOM parser deliberately: this runs in the
 * Vite config (Node, no DOMParser), the schema is flat and stable, and adding
 * an XML dependency for four fields is not worth it.
 *
 * @module data/fmiLightning
 */

/** gml:pos is "lat lon" — EPSG:4326 axis order, not GeoJSON's lon/lat. */
const MEMBER_RE = /<wfs:member>([\s\S]*?)<\/wfs:member>/g;
const POS_RE = /<gml:pos>\s*([-\d.]+)\s+([-\d.]+)\s*<\/gml:pos>/;
const TIME_RE = /<BsWfs:Time>([^<]+)<\/BsWfs:Time>/;
const NAME_RE = /<BsWfs:ParameterName>([^<]+)<\/BsWfs:ParameterName>/;
const VALUE_RE = /<BsWfs:ParameterValue>([^<]+)<\/BsWfs:ParameterValue>/;

/**
 * @typedef {object} LightningStrike
 * @property {string} id           Stable id derived from position and time.
 * @property {number} lat
 * @property {number} lon
 * @property {string} time         ISO-8601 as published.
 * @property {number|null} peakCurrentKa  Signed: negative is a downward
 *   negative flash, which is the common case. Magnitude is what matters.
 * @property {boolean|null} cloudToGround cloud_indicator 0 = ground strike.
 * @property {number|null} multiplicity   Return strokes in the flash.
 */

/**
 * @param {string} xml Raw WFS response body.
 * @returns {LightningStrike[]} One record per strike, newest last.
 */
export function parseFmiLightning(xml) {
  const text = String(xml || '');
  if (!text.includes('<wfs:member>')) return [];

  /** @type {Map<string, LightningStrike>} */
  const byKey = new Map();
  MEMBER_RE.lastIndex = 0;
  let member;
  while ((member = MEMBER_RE.exec(text)) !== null) {
    const body = member[1];
    const pos = POS_RE.exec(body);
    const time = TIME_RE.exec(body);
    if (!pos || !time) continue;

    const lat = Number(pos[1]);
    const lon = Number(pos[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const key = `${pos[1]},${pos[2]},${time[1]}`;
    let strike = byKey.get(key);
    if (!strike) {
      strike = {
        id: `fmi-${key}`,
        lat,
        lon,
        time: time[1],
        peakCurrentKa: null,
        cloudToGround: null,
        multiplicity: null,
      };
      byKey.set(key, strike);
    }

    const name = NAME_RE.exec(body)?.[1];
    const rawValue = VALUE_RE.exec(body)?.[1];
    if (!name || rawValue === undefined) continue;
    const value = Number(rawValue);
    // NaN is FMI's "missing", which is a real state here and must not become 0.
    if (!Number.isFinite(value)) continue;

    if (name === 'peak_current') strike.peakCurrentKa = value;
    else if (name === 'multiplicity') strike.multiplicity = value;
    else if (name === 'cloud_indicator') strike.cloudToGround = value === 0;
  }

  return Array.from(byKey.values());
}

/**
 * Strength band for presentation, by absolute peak current.
 *
 * Bands rather than a continuous scale because the eye cannot read a gradient
 * across scattered points, and because peak current spans two orders of
 * magnitude -- a linear ramp would make everything below 100 kA look identical.
 *
 * @param {number|null|undefined} peakCurrentKa
 * @returns {'weak'|'moderate'|'strong'}
 */
export function strikeStrength(peakCurrentKa) {
  const magnitude = Math.abs(Number(peakCurrentKa) || 0);
  if (magnitude >= 80) return 'strong';
  if (magnitude >= 25) return 'moderate';
  return 'weak';
}

/**
 * Age of a strike in minutes, for fading recent activity in.
 * @param {string} isoTime
 * @param {number} nowMs
 * @returns {number} Minutes, or Infinity when unparseable.
 */
export function strikeAgeMinutes(isoTime, nowMs) {
  const t = Date.parse(String(isoTime || ''));
  if (!Number.isFinite(t)) return Infinity;
  return (nowMs - t) / 60000;
}
