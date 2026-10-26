# syntax=docker/dockerfile:1.7

ARG ALPINE_VERSION=3.22

# The web assets and compiled server JavaScript are architecture-independent.
# Build them once on the native GitHub runner instead of repeating this work
# under QEMU for every target architecture.
FROM --platform=$BUILDPLATFORM alpine:${ALPINE_VERSION} AS builder

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

RUN --mount=type=secret,id=proxy_ca \
    if [ -s /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    apk add --no-cache \
      bash \
      curl \
      nodejs \
      npm \
      patch \
      unzip

WORKDIR /opt/codex-web
COPY . .

ARG SOURCE_REVISION=unknown
ENV VITE_CODEX_WEB_REVISION=$SOURCE_REVISION

RUN --mount=type=secret,id=proxy_ca \
    if [ -s /run/secrets/proxy_ca ]; then \
      export SSL_CERT_FILE=/run/secrets/proxy_ca \
             CURL_CA_BUNDLE=/run/secrets/proxy_ca \
             NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; \
    fi; \
    npm ci --ignore-scripts --no-audit --no-fund \
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

RUN --mount=type=secret,id=proxy_ca \
    if [ -s /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    apk add --no-cache \
      g++ \
      make \
      nodejs \
      nodejs-dev \
      npm \
      python3

# node-gyp expects common.gypi at the Node source root, while Alpine packages
# it with the other headers. The link lets it reuse Alpine's local headers.
RUN --mount=type=secret,id=proxy_ca \
    if [ -s /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    ln -s /usr/include/node/common.gypi /usr/common.gypi \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm_config_build_from_source=true npm_config_nodedir=/usr npm rebuild better-sqlite3 \
    && npm cache clean --force

FROM alpine:${ALPINE_VERSION} AS runtime

RUN --mount=type=secret,id=proxy_ca \
    if [ -s /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    apk add --no-cache nodejs \
    && addgroup -g 1000 node \
    && adduser -D -u 1000 -G node node \
    && mkdir -p /home/node/.codex \
    && chown node:node /home/node/.codex

ARG SOURCE_REVISION=unknown

ENV NODE_ENV=production \
    HOME=/home/node \
    HOST=0.0.0.0 \
    PORT=8214 \
    CODEX_WEB_USER_DATA_DIR=/home/node/.codex \
    CODEX_WEB_DISABLE_INTERNAL_APP_MCP=1 \
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

# Keep the existing, CLI-free runtime as Docker's default final stage. The
# combined target is built explicitly with --target all-in-one.
FROM ghcr.io/icoretech/codex-docker:0.164.0@sha256:6914e21df86000b9c10efb4a49ef36dfbb267b5ba04b9741ef3cf648855d9c83 AS cli

FROM runtime AS all-in-one

USER root
RUN --mount=type=secret,id=proxy_ca \
    if [ -s /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    apk add --no-cache bash bubblewrap ca-certificates git openssh-client ripgrep tini \
    && mkdir -p /data/cli /data/web /data/workspace /data/auth /home/node/Documents /run/codex \
    && rmdir /home/node/.codex \
    && ln -s /data/cli /home/node/.codex-cli \
    && ln -s /data/web /home/node/.codex \
    && ln -s /data/workspace /workspace \
    && ln -s /data/workspace /home/node/Documents/Codex \
    && chown -R node:node /data /run/codex \
    && chmod 0700 /data/auth

COPY --from=cli /usr/local/bin/codex /usr/local/bin/codex
COPY --from=cli /usr/local/bin/codex-code-mode-host /usr/local/bin/codex-code-mode-host
COPY --from=cli /usr/local/bin/codex-bootstrap /usr/local/bin/codex-bootstrap
COPY --chmod=0555 docker/all-in-one-entrypoint.sh /opt/codex-web/docker/all-in-one-entrypoint.sh

ARG CODEX_CLI_VERSION=0.164.0
RUN test "$(codex --version)" = "codex-cli ${CODEX_CLI_VERSION}"

ENV CODEX_HOME=/home/node/.codex-cli \
    CODEX_APP_SERVER_URL=unix:///run/codex/app-server.sock \
    CODEX_WEB_AUTH_DIR=/data/auth

LABEL org.opencontainers.image.description="Codex Web and pinned Codex CLI in one container" \
      org.opencontainers.image.codex-cli-version="${CODEX_CLI_VERSION}"

USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/bin/sh", "-ec", "test -S /run/codex/app-server.sock && node -e \"fetch(new URL(process.env.CODEX_WEB_BASE_PATH||'/', 'http://127.0.0.1:8214'),{headers:{Accept:'text/html'}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
ENTRYPOINT ["/sbin/tini", "--", "/opt/codex-web/docker/all-in-one-entrypoint.sh"]
CMD ["node", "src/server/main.js", "--host", "0.0.0.0", "--port", "8214"]

# A plain `docker build .` must continue to produce only the Web frontend.
FROM runtime AS web
