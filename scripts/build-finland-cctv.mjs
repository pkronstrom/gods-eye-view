#!/usr/bin/env node
/**
 * Build a CCTV source pack from Fintraffic's Digitraffic road-camera network.
 *
 *   node scripts/build-finland-cctv.mjs > config/cctv_sources.finland.json
 *
 * Digitraffic publishes ~811 public road weather cameras across Finland, free,
 * keyless and CC BY 4.0. The shipped packs cover Austin, California and London,
 * so this is the difference between a handful of US/UK cameras and national
 * coverage of the country the server actually sits in.
 *
 * TWO THINGS THAT WILL BITE THE NEXT PERSON
 *
 * 1. Digitraffic REQUIRES gzip. Without `Accept-Encoding: gzip` every endpoint
 *    answers 406 with a body that reads nothing like a compression error, which
 *    looks exactly like an auth failure if you are not expecting it. Node's
 *    fetch sends it by default; curl does not.
 *
 * 2. There is no compass bearing anywhere in this API. Each preset carries
 *    `direction` as INCREASING_DIRECTION / DECREASING_DIRECTION -- the sense of
 *    travel along the numbered road, not a heading. So headingDeg is deliberately
 *    OMITTED rather than invented: a fabricated bearing would render a confident
 *    view cone pointing at the wrong side of the road, which is worse than no
 *    cone at all. The imagery, which is the point, is unaffected.
 *
 * One preset per station, not all of them: most stations carry two or three
 * views, which would put the pack past the 1200 hard cap and crowd the map with
 * near-duplicate pins at one coordinate. Geographic spread beats angle coverage.
 *
 * Image URLs are CONSTRUCTED, not fetched. The stations list gives each preset
 * only as {id, inCollection}; the imageUrl lives in the per-station detail
 * route. Deriving it from the id instead of making 811 extra requests against a
 * best-effort public service is both faster and better manners. Verified across
 * the network before relying on it -- spot-checked stations spread through the
 * list all resolve to a live image/jpeg.
 *
 * @module scripts/build-finland-cctv
 */

const STATIONS_URL = 'https://tie.digitraffic.fi/api/weathercam/v1/stations';
const IMAGE_URL = (presetId) => `https://weathercam.digitraffic.fi/${presetId}.jpg`;

/**
 * Station names arrive as `kt51_Inkoo` or `vt1_Lohja_Pitkämäki_itä`: a Finnish
 * road designator, then the place, underscore-separated. Split it so the map
 * shows a place rather than a slug, and keep the road as a prefix because it is
 * how these cameras are actually identified.
 * @param {string} raw
 * @returns {{name: string, place: string}}
 */
function readStationName(raw) {
  const parts = String(raw || '').split('_').filter(Boolean);
  if (parts.length < 2) return { name: String(raw || 'Road camera'), place: '' };
  const [road, ...rest] = parts;
  const place = rest.join(' ');
  return { name: `${road.toUpperCase()} ${place}`, place: rest[0] || '' };
}

// Identifies us to Fintraffic, as their terms ask. Not optional politeness:
// an unidentified bulk client is the one they throttle first.
const USER_AGENT = 'gods-eye-view-homelab/0.1 (self-hosted; github.com/pkronstrom/gods-eye-view)';

const LICENSE = 'Fintraffic / Digitraffic road camera, CC BY 4.0';

async function main() {
  const response = await fetch(STATIONS_URL, {
    headers: { 'Accept-Encoding': 'gzip', 'User-Agent': USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`Digitraffic returned ${response.status} — if 406, the gzip header was dropped`);
  }
  const collection = await response.json();
  const features = Array.isArray(collection?.features) ? collection.features : [];
  if (!features.length) throw new Error('no stations in the Digitraffic response');

  const sources = [];
  for (const feature of features) {
    const props = feature?.properties || {};
    const [lon, lat] = feature?.geometry?.coordinates || [];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // A station that is not gathering has no current image; including it would
    // put a permanently broken pin on the map.
    if (props.collectionStatus && props.collectionStatus !== 'GATHERING') continue;

    const presets = Array.isArray(props.presets) ? props.presets : [];
    const preset = presets.find((p) => p?.inCollection) || presets[0];
    if (!preset?.id) continue;

    const { name, place } = readStationName(props.name);

    sources.push({
      id: `fi-${preset.id}`,
      name,
      city: place || 'Finland',
      cityId: place ? `fi-${place.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : 'fi',
      provider: 'Fintraffic Digitraffic',
      sourceKind: 'configured',
      feedType: 'image',
      url: IMAGE_URL(preset.id),
      lat,
      lon,
      // headingDeg intentionally absent — see the note at the top of this file.
      headingConfidence: 'unknown',
      license: LICENSE,
    });
  }

  sources.sort((a, b) => a.id.localeCompare(b.id));
  process.stdout.write(`${JSON.stringify(sources, null, 2)}\n`);
  process.stderr.write(`[finland-cctv] ${sources.length} cameras from ${features.length} stations\n`);
}

main().catch((error) => {
  process.stderr.write(`[finland-cctv] ${error.message}\n`);
  process.exit(1);
});
