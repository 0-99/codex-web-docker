# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS builder

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

RUN apk add --no-cache \
      bash \
      curl \
      g++ \
      make \
      patch \
      python3 \
      unzip

WORKDIR /opt/codex-web
COPY . .

RUN npm ci --no-audit --no-fund \
    && npm prune --omit=dev --ignore-scripts \
    && find scratch/asar -type f -name '*.map' -delete \
    && find src/server -type f ! -name '*.js' -delete \
    && rm -rf scratch/asar/node_modules \
    && npm cache clean --force

FROM node:22-alpine AS runtime

ARG SOURCE_REVISION=unknown

ENV NODE_ENV=production \
    HOME=/home/node \
    HOST=0.0.0.0 \
    PORT=8214 \
    CODEX_CLI_PATH=/opt/codex-web/docker/codex-app-server-proxy.mjs

LABEL org.opencontainers.image.source="https://github.com/0-99/codex-web-docker" \
      org.opencontainers.image.description="CLI-free Docker web frontend for an external Codex app-server" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="$SOURCE_REVISION"

WORKDIR /opt/codex-web

COPY --from=builder --chown=node:node /opt/codex-web/node_modules ./node_modules
COPY --from=builder --chown=node:node /opt/codex-web/src/server ./src/server
COPY --from=builder --chown=node:node /opt/codex-web/scratch/asar/package.json ./scratch/asar/package.json
COPY --from=builder --chown=node:node /opt/codex-web/scratch/asar/.vite/build ./scratch/asar/.vite/build
COPY --from=builder --chown=node:node /opt/codex-web/scratch/asar/native-menu-locales ./scratch/asar/native-menu-locales
COPY --from=builder --chown=node:node /opt/codex-web/scratch/asar/webview ./scratch/asar/webview
COPY --from=builder --chown=node:node --chmod=0555 /opt/codex-web/docker/codex-app-server-proxy.mjs ./docker/codex-app-server-proxy.mjs

USER node

EXPOSE 8214

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8214/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "src/server/main.js", "--host", "0.0.0.0", "--port", "8214"]
