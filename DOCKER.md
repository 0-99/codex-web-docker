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

## Startup, reconnect and thread recovery

The web backend starts even while the external app-server is unavailable. Its
startup panel shows actual connection states, retry countdowns and thread
recovery, without a percentage estimate. The same panel returns after a
connection loss and disappears when the connection and interface are ready.
The status endpoint is `<base-path>__backend/status`; live updates use
`<base-path>__backend/status/events` (SSE). Reverse proxies should forward SSE
without buffering. The UI remains available while the app-server is down.

The first connection attempt is immediate. After a failure, the default waits
are **10 s, 10 s, 20 s, 30 s, then 30 s repeatedly**, without an attempt limit.
Waits begin after a failed attempt; connection/initialization timeouts are in
addition to these delays. The sequence resets after successful recovery.

| Variable                                    | Default                       | Purpose                                                                             |
| ------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------- |
| `CODEX_APP_SERVER_MAX_PAYLOAD`              | `104857600`                   | Maximum WebSocket message size in bytes                                             |
| `CODEX_APP_SERVER_HANDSHAKE_TIMEOUT_MS`     | `10000`                       | Timeout for each connection and `initialize` attempt                                |
| `CODEX_APP_SERVER_RETRY_DELAYS_MS`          | `10000,10000,20000,30000`     | Comma-separated retry waits in milliseconds; repeat the last value                  |
| `CODEX_APP_SERVER_RETRY_MAX_ATTEMPTS`       | `0`                           | Retries after the first attempt; `0` means unlimited                                |
| `CODEX_APP_SERVER_RESUME_TIMEOUT_MS`        | `30000`                       | Timeout for each thread restoration                                                 |
| `CODEX_APP_SERVER_RECONNECT_FAILURE_ACTION` | `terminate-parent` in Docker  | On finite retry exhaustion: `terminate-parent` or `exit` (only the proxy)           |
| `CODEX_WEB_USER_DATA_DIR`                   | `/home/node/.codex` in Docker | Writable Electron user-data directory for web settings, state and artifact sessions |
| `CODEX_WEB_DISABLE_INTERNAL_APP_MCP`         | `1` in Docker                 | Disables the desktop-only `codex_app` MCP integration for an external app-server    |
| `CODEX_WEB_ELECTRON_DEBUG`                  | unset                         | Set to `1` for verbose Electron-stub calls                                          |

For example, `CODEX_APP_SERVER_RETRY_DELAYS_MS=5000,15000` and
`CODEX_APP_SERVER_RETRY_MAX_ATTEMPTS=8` make one initial attempt and at most eight
retries, waiting 5 seconds before the first retry and 15 seconds thereafter.
The proxy still enforces a timeout on each attempt. Desktop `26.901.41123`
keeps local stdio initialization pending after its diagnostic timeout, so no
fork timeout patch is needed. Other transports retain upstream behavior.
Upstream also reloads browser tabs after a lost browser-to-backend IPC
connection; external app-server recovery is handled separately by the proxy.

After reconnect, the proxy sends `initialize` and `initialized`, then restores
threads previously started, resumed or forked through it using `thread/resume`.
Queued requests are released only after this restoration phase. It retains
session configuration, uses stored history by thread ID, and removes threads
that have been unsubscribed, archived or deleted. It does not replay creation
payloads or create replacement threads when stored history is missing.

Requests already sent when a connection is lost receive an explicit error:
their outcome can be unknown and repeating them could duplicate work. Running
turns are not restarted automatically. Unsent requests wait in a bounded queue
(up to 1,000 messages). A thread that cannot be restored returns a specific
error on subsequent requests; other threads remain usable. Explicitly resuming
the affected thread can clear that error. The app-server must retain its own
Codex home/history for restoration after a process restart; ephemeral threads
may be lost permanently.

### Deprecated reconnect settings

Existing deployments explicitly setting any of the following variables retain
the previous finite two-phase strategy and receive a deprecation warning:

| Deprecated variable                                   | Legacy default |
| ----------------------------------------------------- | -------------- |
| `CODEX_APP_SERVER_RECONNECT_ATTEMPTS`                 | `5`            |
| `CODEX_APP_SERVER_RECONNECT_DELAY_MS`                 | `30000`        |
| `CODEX_APP_SERVER_RECONNECT_BACKOFF_ATTEMPTS`         | `10`           |
| `CODEX_APP_SERVER_RECONNECT_BACKOFF_INITIAL_DELAY_MS` | `300000`       |
| `CODEX_APP_SERVER_RECONNECT_BACKOFF_INCREMENT_MS`     | `300000`       |

This means five retries every 30 seconds, followed by ten retries with waits of
5, 10, through 50 minutes. A phase's attempt count of `0` disables that phase.
Setting either new `RETRY_*` variable takes precedence over all deprecated
schedule variables. `RECONNECT_FAILURE_ACTION` remains supported and does not
select the legacy strategy on its own. Remove legacy schedule variables when
switching to the new defaults; the updated Compose example uses the new names.

Connection failures, scheduled attempts, successful reconnections and thread
restore failures remain in the container log. Routine Electron-stub tracing is
silent unless debug logging is enabled. Browser/system locale detection,
including initial window creation, is scoped to each browser connection.
Upstream's saved `localeOverride` still takes precedence; `en-US` is only the
final fallback. The connection panel currently has German and English text
selected from the browser language.

## Persistence and fresh volumes

The Compose example mounts a named volume at `/home/node/.codex` for web-side
settings and local state. The image creates this directory with UID/GID
`1000:1000` before switching to `USER node`. Docker copies the directory's
ownership into a fresh, empty named volume, so it is writable on first startup
without a root entrypoint or a manual `chown`. The Electron compatibility layer
uses this path for `userData`, so artifact sessions and state files are no
longer written below the read-only application directory `/opt/codex-web`.

```yaml
volumes:
  - codex-web-home:/home/node/.codex
```

Persist the external app-server's Codex home separately as well: that is where
its authentication and thread history live. Match its container's home path
and user according to that image. Do not substitute the web-side volume for
app-server history or share the same database directory between processes.

## Desktop-only app MCP

The upstream desktop bundle tries to attach its internal `codex_app` MCP server
whenever it believes it launched a local CLI. Here the apparent local CLI is
only a relay to an external app-server. The image therefore sets
`CODEX_WEB_DISABLE_INTERNAL_APP_MCP=1`. It prevents an upstream configuration
compatibility error (`invalid transport in mcp_servers.codex_app`) from blocking
new and resumed chats. The desktop-only tools provided by that MCP server are
not available through the web wrapper.

The relay also removes a `mcp_servers.codex_app` override from thread requests
before they reach an external app-server. This covers overrides supplied by the
Desktop UI or a restored web thread without changing the CLI's persisted
`config.toml` or other MCP servers. The relay reports when it removes one.

Set the variable to `0` only when the external app-server is confirmed to
support the matching upstream desktop bundle's internal MCP configuration.
Existing bind mounts and volumes with `volume-nocopy` keep their existing host
ownership; image initialization does not change arbitrary host directories.

## Visible web build revision

Open the Help menu in the sidebar to see **Web build**. It shows the Git commit
used to build the running `codex-web` image. This identifies the web frontend
itself, independently of the bundled Desktop version and the external Codex
app-server version.

## Separate codex-cli container sandbox

The tested configuration for the separate CLI container is:

```yaml
security_opt:
  - seccomp=unconfined
  - systempaths=unconfined
```

In the tested deployment, neither `SYS_ADMIN` nor `apparmor=unconfined`
was required. Apply these options to the **codex-cli/app-server service**;
the web frontend requires neither option. The optional
[`examples/app-server-security.compose.yml`](examples/app-server-security.compose.yml)
overlay shows this configuration. The CLI image, authentication and workspace
mounts remain part of the separately managed app-server deployment.

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

The manifest link uses `crossorigin="use-credentials"`. This is harmless on an
unprotected installation and lets a reverse proxy protected by Authelia or any
other cookie-based authentication gateway authorize the manifest request.

## Compose and Portainer

When the app-server runs in another container on the same Docker host, create
the external user-defined bridge network once:

```sh
docker network create --driver bridge codex
```

This keeps both containers off the host network while providing automatic DNS
resolution between them. Docker's shared default `bridge` network is not used.
General internet access from `codex-web` is not required for the core workflow
through an external app-server. On an internal-only network, optional Desktop
requests for feature flags, account metadata, usage and cloud tasks may log
`sa_server_request_failed` and return `/wham/...` status 500; the app-server
container remains responsible for Codex/OpenAI connectivity.

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
