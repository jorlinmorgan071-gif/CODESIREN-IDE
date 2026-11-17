# server/Dockerfile
#
# Multi-stage build for the Code Siren backend.
#
#   docker build -t code-siren-server ./server
#
# Stage 1 (builder): installs ALL deps (incl. devDeps for tsc), compiles TS,
#   copies non-TS assets (SQL migrations, TOML skills) via copy-assets.mjs,
#   then prunes devDeps so only production deps + their already-compiled
#   native binaries remain.
# Stage 2 (runtime): copies the pruned node_modules + dist/ from the builder.
#   No npm install runs here, so no native compilation toolchain is needed
#   and the image stays slim.
#
# node-pty is a native C++ addon (a forkpty binding). It does NOT ship Linux
# prebuilds, so `npm ci` compiles it from source via node-gyp, which needs
# python3 + make + g++. Those tools live ONLY in the builder stage: the
# compiled pty.node binary is built once there and copied into the runtime,
# which only needs libutil1 to load it. isolated-vm is also native; the same
# builder-compile / runtime-copy path covers it.
#
# If node-pty ever fails to compile, the server still boots: pty-manager.ts
# loads it lazily and disables the terminal with a clear message when the
# binary is absent (see server/src/terminal/pty-manager.ts).

# ── Stage 1: builder ──────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

# node-pty compiles from source on Linux (no prebuilt binaries). node-gyp
# needs python3, make, and a C++ compiler (g++). Build-only — never copied
# to the runtime image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests first for layer caching. npm ci compiles node-pty (and any
# other native addon without a prebuild) using the toolchain above.
COPY package.json package-lock.json ./
RUN npm ci

# Copy source + build config, then compile.
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/

# tsc compiles src/**/*.ts → dist/src/**/*.js, then copy-assets.mjs copies
# the .sql and .toml files that tsc leaves behind (loaded at runtime via
# __dirname).
RUN npm run build

# Drop devDependencies (tsc, vitest, typescript, @types/*) but KEEP the
# production deps and their already-compiled native binaries
# (node_modules/node-pty/build/Release/pty.node, etc.). prune does not
# rebuild or rerun install scripts, so the compiled artifacts survive.
RUN npm prune --omit=dev

# ── Stage 2: runtime ──────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# No apt-get step: node-pty's compiled pty.node links only against
# libstdc++.so.6 / libgcc_s.so.1 / libc.so.6 / libm.so.6 (verified via ldd),
# all of which ship in node:22-bookworm-slim (libstdc++6 is a Node runtime
# dep). The old comment claiming node-pty "links against libutil" was wrong,
# and `libutil1` is not even a bookworm package (libutil was merged into
# glibc/libc6 in glibc 2.34+; bookworm ships glibc 2.36, which already
# provides libutil.so.1 via libc6). Keeping the runtime apt-free makes the
# image slimmer and removes a build-breaking package lookup.

WORKDIR /app

# Copy the pruned production node_modules (with compiled native binaries)
# and the build output from the builder stage. No npm install runs in the
# runtime stage, so no second compile attempt and no need for build tools.
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
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
