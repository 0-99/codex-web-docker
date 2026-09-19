# syntax=docker/dockerfile:1.7

ARG ALPINE_VERSION=3.22

# The web assets and compiled server JavaScript are architecture-independent.
# Build them once on the native GitHub runner instead of repeating this work
# under QEMU for every target architecture.
FROM --platform=$BUILDPLATFORM alpine:${ALPINE_VERSION} AS builder

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

RUN apk add --no-cache \
      bash \
      curl \
      nodejs \
      npm \
      patch \
      unzip

WORKDIR /opt/codex-web
COPY . .

RUN npm ci --ignore-scripts --no-audit --no-fund \
    && npm rebuild sharp \
    && npm run test:docker-proxy \
    && npm run prepare \
    && npm test \
    && find scratch/asar -type f -name '*.map' -delete \
    && find src/server -type f ! -name '*.js' -delete \
    && rm -rf scratch/asar/node_modules \
    && npm cache clean --force

# Alpine provides Node.js 22 for every target platform, including ppc64le.
# Compile the only native runtime dependency separately for each target.
FROM alpine:${ALPINE_VERSION} AS production-dependencies

WORKDIR /opt/codex-web
COPY package.json package-lock.json ./

RUN apk add --no-cache \
      g++ \
      make \
      nodejs \
      nodejs-dev \
      npm \
      python3

# node-gyp expects common.gypi at the Node source root, while Alpine packages
# it with the other headers. The link lets it reuse Alpine's local headers.
RUN ln -s /usr/include/node/common.gypi /usr/common.gypi \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm_config_build_from_source=true npm_config_nodedir=/usr npm rebuild better-sqlite3 \
    && npm cache clean --force

FROM alpine:${ALPINE_VERSION} AS runtime

RUN apk add --no-cache nodejs \
    && addgroup -g 1000 node \
    && adduser -D -u 1000 -G node node \
    && mkdir -p /home/node/.codex \
    && chown node:node /home/node/.codex

ARG SOURCE_REVISION=unknown

ENV NODE_ENV=production \
    HOME=/home/node \
    HOST=0.0.0.0 \
    PORT=8214 \
    CODEX_WEB_BASE_PATH=/ \
    CODEX_APP_SERVER_RECONNECT_FAILURE_ACTION=terminate-parent \
    CODEX_CLI_PATH=/opt/codex-web/docker/codex-app-server-proxy.mjs

LABEL org.opencontainers.image.source="https://github.com/0-99/codex-web-docker" \
      org.opencontainers.image.description="CLI-free Docker web frontend for an external Codex app-server" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="$SOURCE_REVISION"

WORKDIR /opt/codex-web

COPY --from=production-dependencies --chown=node:node /opt/codex-web/node_modules ./node_modules
COPY --from=builder --chown=node:node /opt/codex-web/src/server ./src/server
COPY --from=builder --chown=node:node /opt/codex-web/scratch/asar/package.json ./scratch/asar/package.json
COPY --from=builder --chown=node:node /opt/codex-web/scratch/asar/.vite/build ./scratch/asar/.vite/build
COPY --from=builder --chown=node:node /opt/codex-web/scratch/asar/native-menu-locales ./scratch/asar/native-menu-locales
COPY --from=builder --chown=node:node /opt/codex-web/scratch/asar/webview ./scratch/asar/webview
COPY --from=builder --chown=node:node --chmod=0555 /opt/codex-web/docker ./docker

USER node

EXPOSE 8214

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(new URL(process.env.CODEX_WEB_BASE_PATH||'/', 'http://127.0.0.1:8214')).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "src/server/main.js", "--host", "0.0.0.0", "--port", "8214"]
