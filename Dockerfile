# syntax=docker/dockerfile:1

# pagecast — preview & publish HTML reports.
#
# This image bundles the full `pagecast` CLI, so a single image both serves the
# admin dashboard (`serve`, the default command) AND runs every publish/deploy
# subcommand. The dashboard and the CLI are the same program — installing one
# installs both.
#
# Base is Node 22 (current LTS). Native Pagecast and the pinned Wrangler support
# Node >=20.19.0; the container stays on the newer LTS for its production runtime.
FROM node:22-slim

# wrangler is the Cloudflare CLI that pagecast shells out to for publishing and
# deploys. Read the exact version from the same runtime module used by native
# Pagecast, then select this baked global binary at runtime so container deploys
# neither drift versions nor contact npm after the image has been built.
COPY src/platform.js /tmp/pagecast-platform.mjs
RUN node --input-type=module -e \
  'import { spawnSync } from "node:child_process"; import { PINNED_WRANGLER_VERSION } from "file:///tmp/pagecast-platform.mjs"; const result = spawnSync("npm", ["install", "--global", "--no-audit", "--no-fund", `wrangler@${PINNED_WRANGLER_VERSION}`], { stdio: "inherit" }); process.exit(result.status ?? 1);' \
  && rm -f /tmp/pagecast-platform.mjs \
  && npm cache clean --force

WORKDIR /app

# Runtime dependencies (satori + resvg WASM for publish-time OG card rendering)
# install from the frozen lockfile with lifecycle scripts disabled, then only
# the files the CLI needs at runtime are copied in. Own them as the
# unprivileged `node` user (uid 1000, shipped with the base image).
COPY --chown=node:node package.json package-lock.json llms.txt ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node src/ ./src/
COPY --chown=node:node public/ ./public/
COPY --chown=node:node assets/ ./assets/
COPY --chown=node:node feedback/ ./feedback/

# Pre-create the state dir and hand /app to `node` so the unprivileged process
# can write .pagecast when no volume is mounted (and with a named volume, which
# inherits this ownership). A bind mount uses the host dir's ownership instead.
RUN mkdir -p /app/.pagecast && chown -R node:node /app

# Inside a container the servers must listen on all interfaces for Docker port
# mapping to reach them; outside Docker the default stays 127.0.0.1. ALWAYS map
# these ports to the host's loopback only (see docker-compose.yml). The explicit
# loopback-proxy opt-in below permits only the container wildcard case; arbitrary
# routable bind hosts stay rejected. Browser Origin/CSRF and local command
# capabilities are not remote-user authentication, and the admin server can run
# user-configured build commands.
ENV HOST=0.0.0.0 \
    PAGECAST_ALLOW_LOOPBACK_PROXY=1 \
    PAGECAST_USE_GLOBAL_WRANGLER=1 \
    PORT=4173 \
    PUBLIC_PORT=4174

EXPOSE 4173 4174

# Liveness probe for the `serve` workflow: the admin server answers loopback
# requests (Host: localhost passes its DNS-rebinding guard). Uses node directly
# so the slim image needs no curl/wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||4173)+'/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

# Drop root: the admin server can run user-configured build commands, so the
# runtime process runs as the unprivileged `node` user. Ports 4173/4174 are
# >1024, so no privilege is needed to bind them.
USER node

# Absolute path so the CLI works even when callers override the working dir,
# e.g. `docker run -v "$PWD:/work" -w /work pagecast publish ./report.html`.
ENTRYPOINT ["node", "/app/src/cli.js"]
CMD ["serve"]
