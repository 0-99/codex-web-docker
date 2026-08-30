# Docker image

This fork publishes a CLI-free web frontend. The image never installs or starts
the Codex CLI. It starts only the browser frontend and its Electron-to-browser
bridge, then connects that bridge to an independently managed `codex
app-server`.

The app-server does not have to run in Docker. It can run in another container,
natively on the Docker host, or on another reachable system. Compatibility
depends on the transport endpoint, not on how the app-server is deployed.

Published platforms:

- `linux/amd64`
- `linux/arm64`
- `linux/ppc64le`
- `linux/s390x`
- `linux/arm/v7`

## Connection to the app-server

Set `CODEX_APP_SERVER_URL` to one of these endpoints:

- `ws://codex-app-server:4500` for a WebSocket listener on a private Docker
  network;
- `wss://codex-app-server.example:4500` for a TLS WebSocket listener; or
- `unix:///run/codex/app-server.sock` for a shared Unix socket.

For example, the external Codex container can start its server with:

```sh
codex app-server --listen ws://0.0.0.0:4500
```

Keep the app-server endpoint private and do not expose it to the internet. When
the app-server runs in another container, both containers should join the same
private Docker network. A native app-server can instead use an address that is
reachable from the web container or a Unix socket whose directory is mounted
into the container. The WebSocket network transport is currently marked
experimental upstream; a shared Unix socket is the more conservative option
when both processes run on the same host.

For a Unix socket, mount the same directory or named volume in both containers,
start the server with an absolute socket path, and configure the web container:

```yaml
environment:
  CODEX_APP_SERVER_URL: unix:///run/codex/app-server.sock
volumes:
  - codex-app-server-socket:/run/codex
```

The image also accepts these optional limits:

| Variable                                |     Default | Purpose                                 |
| --------------------------------------- | ----------: | --------------------------------------- |
| `CODEX_APP_SERVER_MAX_PAYLOAD`          | `104857600` | Maximum WebSocket message size in bytes |
| `CODEX_APP_SERVER_HANDSHAKE_TIMEOUT_MS` |     `10000` | Connection timeout in milliseconds      |

## Hosting below a URL path

By default, the web application is served at `/`. Set `CODEX_WEB_BASE_PATH` to
host it below an arbitrary URL path without assigning a dedicated domain:

```yaml
environment:
  CODEX_WEB_BASE_PATH: /my/example/subdir/
```

The example is then available at
`https://example.org/my/example/subdir/`. The setting applies to the complete
application, including static assets, browser navigation, uploads, the PWA
manifest, and the IPC WebSocket.

The value must be an absolute URL path. A missing trailing slash is normalized
automatically, and `/` remains the default. Configure the reverse proxy to
forward the prefix unchanged to `codex-web:8214`; do not strip or rewrite it.
WebSocket upgrades must remain enabled. Direct access through the example's
local port uses the same path, for example
`http://127.0.0.1:8214/my/example/subdir/`.

## Compose and Portainer

When the app-server runs in another container on the same Docker host, create
the external user-defined bridge network once:

```sh
docker network create --driver bridge codex
```

This keeps both containers off the host network while providing automatic DNS
resolution between them. Docker's shared default `bridge` network is not used.

Then set `WORKSPACE_PATH` and, if needed, `CODEX_APP_SERVER_URL`, and deploy
[`examples/docker-compose.yml`](examples/docker-compose.yml). The app-server
must access project directories at the same absolute paths as `codex-web`,
whether it runs in a container or natively; otherwise the web file picker and
Codex will refer to different files.

The example publishes the UI only on `127.0.0.1:8214` for local testing. For
Nginx Proxy Manager, attach `codex-web` and Nginx Proxy Manager to a dedicated
proxy network, remove the `ports` entry, and proxy to `codex-web:8214`.

There is deliberately no authentication inside this image. Anyone who can
reach the UI can operate the connected Codex instance with that instance's
permissions. Keep the app-server private and place an authentication layer or
VPN in front of the web UI before exposing it beyond a trusted network.

## Docker Hub publishing

The GitHub Actions workflow publishes releases to `0to99/codex-web-docker` on
Docker Hub for all supported platforms. Configure these repository secrets:

- `DOCKER_USERNAME`
- `DOCKER_PASSWORD` (use a Docker Hub access token)

Publishing a GitHub release produces the release tag and the Docker metadata
action's matching tags, including `latest` for a stable semantic version.
