/**
 * Mirror dev-only API proxies onto the preview server.
 *
 * 19 of the proxy plugins in vite.config.js register `configureServer`; only 9
 * also register `configurePreviewServer`. Under `vite preview` the other 10
 * (OpenSky, adsb.lol, CelesTrak, ADSBDB, CCTV, Overpass, GBFS, FIRMS, TomTom,
 * terrain-heights) mount nothing and their layers silently render empty.
 *
 * Safe because every plugin lacking a preview hook touches only
 * `server.middlewares`, which both server types expose. The sole plugin using
 * `server.httpServer` (ais-live-proxy) already has its own preview hook.
 */
export const ensurePreviewApiProxies = (plugins) => plugins.map((plugin) => (
  plugin
  && typeof plugin.configureServer === 'function'
  && typeof plugin.configurePreviewServer !== 'function'
    ? { ...plugin, configurePreviewServer: plugin.configureServer }
    : plugin
));
