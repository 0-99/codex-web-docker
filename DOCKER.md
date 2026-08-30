# Docker image

This fork publishes a CLI-free web frontend. The image never installs or starts
the Codex CLI. It starts only the browser frontend and its Electron-to-browser
bridge, then connects that bridge to an independently managed `codex
app-server`.

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

Do not publish the app-server port to the host or the internet. Both containers
should join the same private Docker network. The WebSocket network transport is
currently marked experimental upstream; a shared Unix socket is the more
conservative option when both containers run on the same Docker host.

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

## Compose and Portainer

Create the external network once:

```sh
docker network create codex
```

Then set `WORKSPACE_PATH` and, if needed, `CODEX_APP_SERVER_URL`, and deploy
`compose.yml`. The app-server container must mount project directories at the
same container paths as `codex-web`; otherwise the web file picker and Codex
will refer to different files.

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
