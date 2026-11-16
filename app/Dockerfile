# app/Dockerfile
#
# Multi-stage build for the Code Siren frontend (React + Vite).
#
#   docker build -t code-siren-app ./app
#
# Stage 1 (builder): installs deps, runs vite build → dist/
# Stage 2 (runtime): nginx:alpine serves the static dist/ on port 8080
#   (non-root, no Node runtime — ~10MB image)
#
# The app talks to the backend over HTTP/WS using VITE_API_URL /
# VITE_WS_URL (baked at build time). In docker-compose these point at
# the `server` service.

# ── Stage 1: builder ──────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig*.json ./
COPY vite.config.ts ./
COPY eslint.config.* ./
COPY index.html ./
COPY src/ ./src/
COPY public/ ./public/

# Build-time env: where the app finds the backend inside the compose network.
# Override with --build-arg in production deploys.
ARG VITE_API_URL=http://localhost:3001/api
ARG VITE_WS_URL=ws://localhost:3001/ws
ARG VITE_WORKSPACE_ROOT=
ENV VITE_API_URL=$VITE_API_URL \
    VITE_WS_URL=$VITE_WS_URL \
    VITE_WORKSPACE_ROOT=$VITE_WORKSPACE_ROOT

RUN npm run build

# ── Stage 2: runtime (nginx) ─────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

# nginx config: serves dist/ on :8080, falls back to index.html for SPA routes
RUN mkdir -p /etc/nginx/templates
COPY <<'EOF' /etc/nginx/templates/default.conf.template
server {
    listen 8080;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # SPA fallback — any route that isn't a real file goes to index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache fingerprinted assets aggressively (Vite emits content hashes)
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Security headers
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}
EOF

# Copy the built static files from the builder stage
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost:8080/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
