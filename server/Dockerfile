# server/Dockerfile
#
# Multi-stage build for the Code Siren backend.
#
#   docker build -t code-siren-server ./server
#
# Stage 1 (builder): installs ALL deps (incl. devDeps for tsc), compiles TS,
#   and copies non-TS assets (SQL migrations, TOML skills) via copy-assets.mjs.
# Stage 2 (runtime): installs only runtime deps, copies the compiled dist/,
#   and exposes port 3001.
#
# node-pty ships prebuilt binaries for linux-x64 (glibc) on Node 22, so no
# native compilation toolchain is needed in either stage. If the prebuild is
# missing for your arch, install build-essential in the builder stage.

# ── Stage 1: builder ──────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Copy manifests first for layer caching
COPY package.json package-lock.json ./
RUN npm ci

# Copy source + build config, then compile
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/

# tsc compiles src/**/*.ts → dist/src/**/*.js, then copy-assets.mjs copies
# the .sql and .toml files that tsc leaves behind (loaded at runtime via
# __dirname).
RUN npm run build

# ── Stage 2: runtime ──────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# node-pty's prebuild links against libutil; bookworm-slim doesn't ship it
# by default. Install the minimal runtime lib and clean up apt cache.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libutil1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Runtime deps only (smaller image, no tsc/vitest/typescript)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy the compiled output + assets from the builder stage
COPY --from=builder /app/dist ./dist

# Non-secret env defaults — override in docker-compose.yml or .env
ENV NODE_ENV=production \
    PORT=3001 \
    PG_HOST=db \
    PG_PORT=5432 \
    PG_DB=code_siren \
    PG_USER=code_siren \
    PG_PASSWORD=code_siren \
    TERMINAL_ENABLED=false

EXPOSE 3001

# Healthcheck: the server exposes GET /api/health which returns 200 once
# Express + WS + all agents are initialized.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
