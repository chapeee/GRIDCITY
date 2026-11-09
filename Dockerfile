# syntax=docker/dockerfile:1.7
#
# Multi-stage image used by both compose files:
#   dev      – full toolchain, source bind-mounted by compose.dev.yaml
#   build    – compiles the web client and bundles the server
#   runtime  – small production image used by compose.yaml
#
# No image or container names are hardcoded: compose derives them from the
# directory name, so renaming the project needs no change here.

ARG NODE_VERSION=24

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
WORKDIR /repo
# Build tools are only a fallback for native modules without a prebuilt binary.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
FROM base AS deps
# Copy manifests first so dependency layers are cached across source edits.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
FROM deps AS dev
COPY . .
CMD ["npm", "run", "dev"]

# ---------------------------------------------------------------------------
FROM dev AS build
RUN npm run build

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
  # The container's loopback is unreachable from the host, so bind all
  # interfaces *inside* the container. compose.yaml publishes the port on the
  # host's 127.0.0.1 only. The server refuses 0.0.0.0 without this flag.
  HOST=0.0.0.0 \
  BIND_INSIDE_CONTAINER=true
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm \
  npm ci --omit=dev --workspace @app/server --no-audit --no-fund

COPY --from=build /repo/apps/server/dist apps/server/dist
COPY --from=build /repo/apps/web/dist apps/web/dist

# Config and data directories owned by the unprivileged user, so named volumes
# mounted there inherit that ownership and SQLite can write.
RUN mkdir -p /config /data && chown node:node /config /data
USER node
EXPOSE 4600
CMD ["node", "--enable-source-maps", "apps/server/dist/index.js"]
