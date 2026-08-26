# God's Eye View — homelab build.
#
# Single stage on purpose. A builder/runtime split would only shed puppeteer
# and sharp, because `vite preview` still needs vite, vite-plugin-cesium
# (imported by vite.config.js), ws, @mapbox/vector-tile and pbf at runtime --
# the API proxies live inside the Vite config, not in a separate server.
#
# bookworm-slim rather than alpine: sharp is a devDependency and musl builds of
# it are an avoidable trap.
FROM node:24-bookworm-slim

# package.json engines demands >=24.14.0 <25 || >=26 <27. The tag floats, so
# fail the build loudly here rather than at a confusing runtime error.
RUN node -e "const v=process.versions.node.split('.').map(Number); \
  if(!((v[0]===24&&(v[1]>14||(v[1]===14&&v[2]>=0)))||v[0]===26)) \
  { console.error('Unsupported Node '+process.versions.node); process.exit(1); } \
  console.log('Node '+process.versions.node+' ok');"

WORKDIR /app

# Chromium is ~150 MB and is only used by scripts/qa-*.mjs, which never run here.
ENV PUPPETEER_SKIP_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Several proxies persist cache to $PWD/.gev-cache (celestrak, overpass, tomtom,
# terrain-heights, launch-library). Create it owned by uid 1000 BEFORE dropping
# privileges -- a root-owned directory here fails silently: the proxies keep
# serving, they just never cache, and nothing logs it.
RUN mkdir -p /app/.gev-cache && chown -R node:node /app/.gev-cache
VOLUME /app/.gev-cache

USER node

ENV HOST=0.0.0.0 \
    PORT=4173 \
    OPENSKY_AUTH_MODE=anon
EXPOSE 4173

# The binary directly, not `npm run`/`npx`, so signals reach the real process.
CMD ["node_modules/.bin/vite", "preview"]
