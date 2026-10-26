# Docker image

The default image remains a CLI-free web frontend. It never installs or starts
the Codex CLI. It starts only the browser frontend and its Electron-to-browser
bridge, then connects that bridge to an independently managed `codex
app-server`. An additional [all-in-one image](#all-in-one-image) includes the CLI.

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

The example below uses a shared Unix socket. Recent CLI versions reject an
unauthenticated non-loopback WebSocket listener (such as `ws://0.0.0.0:4500`).
The bridge does not currently configure the CLI's `--ws-auth` credentials; use
the Unix-socket setup for the companion image rather than an unprotected TCP
listener. Compatible WebSocket endpoints and authenticating relays remain usable.

Keep the app-server endpoint private. When using a Unix socket, the frontend and
app-server must use matching numeric UIDs so the frontend can connect to the
CLI's owner-only socket. The example initializes both dedicated socket volumes
with mode 0700 for UID 1000; account state remains in a separate app-server home volume.

For a Unix socket, mount the same directory or named volume in both containers,
start the server with an absolute socket path, and configure the web container:

```yaml
environment:
  CODEX_APP_SERVER_URL: unix:///run/codex/app-server.sock
volumes:
  - codex-app-server-socket:/run/codex
  - codex-daemon-socket:/tmp/codex-daemon-1000
```

CLI 0.164.0 creates the physical socket under `/tmp/codex-daemon-<UID>`
and leaves an absolute symlink at the `--listen` path. Both containers must
mount that protected directory at the same absolute path in addition to
`/run/codex`. Sharing only the alias produces a dangling link. The alias parent
must also prevent group/other writes: use mode 0700, replacing the older 0770.
Custom numeric UIDs must also change the daemon mount path and volume owner.
For existing deployments, follow the [CLI 0.164.0 migration](#upgrading-an-existing-stack-to-cli-01640)
before changing the image tag.

### Mobile Connect pairing

Open **Settings → Connections → Control this PC** in the web UI. The fork
offers **Generate pairing code** beside the native **Add** button. It also
appears when the bundled Desktop dialog cannot check security requirements.
Clicking it asks the existing
app-server to enable ephemeral remote control and create a short-lived manual
code; enter the code in ChatGPT Connect on the phone. No second app-server or
startup `--remote-control` option is needed. Existing paired connections
continue to appear in the Desktop connection list.

This fallback is available with `unix:///` app-server endpoints. The pairing
request is same-origin only, and the code is returned solely to the requesting
web page. Protect the web UI with your usual proxy authentication because its
users can already operate the connected Codex session.

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
| `CODEX_WEB_DISABLE_INTERNAL_APP_MCP`        | `1` in Docker                 | Disables the desktop-only `codex_app` MCP integration for an external app-server    |
| `CODEX_WEB_ALLOW_VERIFIED_LEGACY_ROUTING` | unset (disabled) | Set to exactly `1` to permit authenticated verification when `workspaceRouting` is absent; policy checks remain mandatory |
| `CODEX_WEB_ELECTRON_DEBUG`                  | unset                         | Set to `1` for verbose Electron-stub calls                                          |

The legacy routing opt-in belongs on the **Web container**, not the CLI. It is
independent of CLI version and does not override native routing objects, explicit
`null`, account mismatches or managed backend/residency/network/FedRAMP policies.
See [verified legacy routing](docs/verified-legacy-routing.md) for the proof
requirements and tests. A separately approved live test is a one-time initial
acceptance; subsequent releases use automated checks rather than recurring
manual live tests. No production configuration is changed automatically.

For example, `CODEX_APP_SERVER_RETRY_DELAYS_MS=5000,15000` and
`CODEX_APP_SERVER_RETRY_MAX_ATTEMPTS=8` make one initial attempt and at most eight
retries, waiting 5 seconds before the first retry and 15 seconds thereafter.
The proxy still enforces a timeout on each attempt. Desktop `26.1007.30912`
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
final fallback. The build enables the bundled translations when Statsig is
unreachable, so a selected non-English locale also applies to the Desktop UI.
The connection panel currently has German and English text selected from the
browser language.

## Upgrading the web image

The bundled Desktop is `26.1007.30912`. Updating this image replaces the web
interface and bridge; it does not update the independently managed app-server.
The upstream Nix package now pins CLI `0.162.0-alpha.17.2`, but that alpha CLI
is not included in the Docker image and is not an automatic upgrade requirement
for an existing deployment. Check the actual app-server version in the test
stack before deciding whether a separate CLI upgrade is needed.

Keep the current endpoint, base path, networks and persistent volumes. Back up
web-side state before testing the newer Desktop, and retain the previous image
tag for rollback. CI automatically checks new and resumed chats, app-server
restart recovery, the actual mobile composer and the pairing-code path before
image publication. The pairing action is available beside **Add** or **Set up** in the
local connection screen; its RPC still requires a Unix app-server endpoint.

These integration checks run without internet access, using real CLI processes
and fixed local model responses. Cloud pairing replies are simulated; signing
a physical phone into ChatGPT is not part of the automated release checks.

The web build revision now appears under the profile menu's **Help** submenu.

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

Open the profile menu's Help submenu to see **Web build**. It shows the Git commit
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

## Docker Compose

The [example](examples/docker-compose.yml) starts both `codex-cli` and
`codex-web`, with Compose-managed networks and volumes. No existing network,
volume, reverse proxy or MCP credentials are required. If you already run the
older stack, read the [migration steps](#upgrading-an-existing-stack-to-cli-01640)
before deploying this example:


```sh
docker compose -f examples/docker-compose.yml up -d
docker compose -f examples/docker-compose.yml exec codex-cli codex-bootstrap device-auth
docker compose -f examples/docker-compose.yml exec codex-cli codex-bootstrap status
docker compose -f examples/docker-compose.yml exec codex-cli codex
```

Complete device authorization, then trust `/workspace` in the interactive CLI.
Open `http://127.0.0.1:8214/`. The CLI remains available through `compose exec`.
The frontend starts without waiting for CLI health and reconnects automatically.
The socket healthcheck verifies listener presence, not account authorization.

Both containers mount the same workspace at `/workspace` and
`/home/node/Documents/Codex`, including projectless Desktop conversations.
Account/configuration data and web state use separate persistent home volumes.
The two socket volumes are small tmpfs mounts with UID/GID 1000 and mode 0700; they hold no
persistent account data and need no initialization container. Docker creates
project-scoped resource names. Existing installation-specific volumes are not
automatically reused: explicitly map their names in your deployment override
if you want to retain existing data rather than start fresh.

Only the CLI joins the outbound bridge. Its additional internal network is
available for optional MCP/sidecar services. The frontend uses a separate
internal network with a localhost-published port; it has no independent internet
access. Optional Desktop account/feature/cloud requests may fail there while
the core app-server workflow remains available. For Nginx Proxy Manager, attach
the proxy to this project's `web_access` network, remove `ports`, and forward to
`codex-web:8214`. Set `CODEX_WEB_BASE_PATH` for subpath hosting and forward that
prefix unchanged. A proxy is optional for local use.

The example applies `seccomp=unconfined` and `systempaths=unconfined` to the CLI
for bubblewrap namespace and `/proc` operations; these relax Docker restrictions
without granting `SYS_ADMIN`. AppArmor relaxation is commented out and should
only be enabled if the host blocks the sandbox. The frontend retains Docker's
default security settings. The commented `MCP_API_TOKEN` is a generic credential example;
replace the variable name with the one your MCP server expects and configure
the server separately. Passing the variable alone does not configure MCP. `host.docker.internal`
provides host-service access through Docker's host gateway.

There is deliberately no authentication inside this image. Anyone who can
reach the UI can operate the connected Codex instance with that instance's
permissions. Keep the app-server private and place an authentication layer or
VPN in front of the web UI before exposing it beyond a trusted network.

### Choosing a supported CLI version

Both **0.155.1 and 0.164.0** are supported during the transition. There is no
requirement to upgrade an existing 0.155.1 installation or change its socket
volumes while it stays on that version.

The example defaults to 0.164.0. To select the older supported version, set
this in the Compose project's `.env` file:

```dotenv
CODEX_CLI_VERSION=0.155.1
```

Use `CODEX_CLI_VERSION=0.164.0` for the newer version. The updated example's
two socket volumes and mode 0700 work with both versions; 0.155.1 simply does
not use the protected daemon directory. CI requires the real-container tests
and the fresh-volume Compose probes to pass for both versions.

Changing an existing 0.155.1 deployment to 0.164.0 also requires the socket
migration below. Changing back to 0.155.1 can retain the updated volume layout.
Support for the older version should only be removed in an explicit later change.

### Upgrading an existing stack to CLI 0.164.0

CLI 0.155.1 placed the socket directly at `/run/codex/app-server.sock`.
CLI 0.164.0 leaves a symlink there and places the physical socket in
`/tmp/codex-daemon-1000/`. Containers have separate `/tmp` directories;
sharing only the old volume therefore exposes the link without its target.

Update an existing Docker Compose deployment as follows:

1. Set `CODEX_CLI_VERSION=0.164.0` in `.env` when using the example, or set
   the CLI image to `ghcr.io/icoretech/codex-docker:0.164.0` in your own Compose file.
2. Keep `codex_socket:/run/codex` in both services and add
   `codex_daemon:/tmp/codex-daemon-1000` to **both** services.
3. Add the top-level `codex_daemon` volume definition from the
   [example Compose file](examples/docker-compose.yml). Both socket volumes
   use tmpfs, UID/GID 1000 and mode `0700`; change the old `codex_socket`
   option from `mode=0770` to `mode=0700`.
4. Stop both services and remove their stopped containers so they release
   the socket volume. Remove **only the old transient socket volume**
   corresponding to `codex_socket`. Docker Compose normally prefixes its
   actual name with the project name; confirm its mount was `/run/codex`.
   Editing the YAML alone does not update options on an existing named volume.
5. Redeploy/recreate both services. Docker creates the socket volumes with
   the new options. Keep `CODEX_APP_SERVER_URL=unix:///run/codex/app-server.sock`
   and the existing `app-server --listen` command.

The socket volumes hold temporary connection files only. Preserve the existing
account, web-state and workspace volumes and their deployment-specific names.
**Do not use `docker compose down -v`**, which would remove other stack volumes
as well. Changing the CLI tag alone is insufficient for this migration.

These paths assume both containers run as UID 1000. For a custom numeric UID,
adjust the daemon path in both mounts and the ownership of both socket volumes.
The protected directory must be mounted at the same absolute path in both
containers so the symlink resolves.
## All-in-one image

The optional image combines this Web build with the **same pinned CLI version**
as the default Compose app-server (`0.164.0` at this revision). Both processes
run as UID 1000 in one container and communicate over a private Unix socket;
the CLI's protected socket target remains in the same container, so it needs no
shared socket volume. The app-server does not expose a network port. One
persistent volume at `/data` contains `cli/` (CLI login/history), `web/` (Web
state), `workspace/` and `auth/`. The image maps `/workspace` and
`/home/node/Documents/Codex` to the same `workspace/` directory. The image includes
`codex`, `codex-code-mode-host`, `codex-bootstrap`, Bubblewrap, Git, SSH and
Ripgrep. It supports `linux/amd64` and `linux/arm64`.

```sh
docker compose -f examples/all-in-one.compose.yml up -d
docker compose -f examples/all-in-one.compose.yml exec codex codex-bootstrap device-auth
docker compose -f examples/all-in-one.compose.yml exec codex codex-bootstrap status
docker compose -f examples/all-in-one.compose.yml exec codex codex
```

Complete device authorization, trust `/workspace` in the interactive CLI, then
open `http://127.0.0.1:8214/`. Set `CODEX_WEB_BASE_PATH` for a reverse-proxy
subpath. The image's healthcheck requires both the Web endpoint and app-server
socket. Restarting the container restarts both processes; the data volume retains
authentication and thread history. The two-container example uses different
volume names, so switching an existing installation requires an explicit data
migration.

### Optional Web login

Set `CODEX_WEB_AUTH_ENABLED=1` in the project `.env` or Compose environment,
then start the container. If no Web account exists, the Web URL opens a setup
form instead of Codex. Read the one-time setup code with
`docker compose -f examples/all-in-one.compose.yml logs codex` and enter it with
a username and a password of at least 12 characters. The code changes on each
restart until setup is complete. Credentials are stored as a salted password
hash in `/data/auth/credentials.json`, never as a plaintext environment
variable. This file persists in the same data volume. The CLI and Web process
share UID 1000, so the CLI can read the hash; this login protects against
access through the network, not against code already running in the container.

The login protects static assets, API requests, uploads and the IPC WebSocket.
Sessions last up to 12 hours, are cleared by a container restart, and use an
HttpOnly, SameSite cookie. The Web UI includes **Sign out**. Set
`CODEX_WEB_AUTH_COOKIE_SECURE=1` when the browser uses an HTTPS reverse proxy;
leave it at `0` only for loopback HTTP or an encrypted VPN. Forward the original
Host header and allow WebSocket upgrades. The login does not encrypt HTTP
traffic: use HTTPS or a VPN before exposing the port on a network. The sample
Compose file binds the port to loopback.

To temporarily turn off the login, set `CODEX_WEB_AUTH_ENABLED=0` and recreate
the container; the stored account remains. To reset a forgotten password, run
`docker compose -f examples/all-in-one.compose.yml exec codex node /opt/codex-web/docker/web-auth-reset.mjs reset`,
then restart the container and use its new setup code. If the container cannot
start, use `docker compose -f examples/all-in-one.compose.yml run --rm --entrypoint node codex /opt/codex-web/docker/web-auth-reset.mjs reset` instead.

### Moving from the earlier three-volume example

Stop the old all-in-one container and back up its CLI, Web and workspace
volumes. Create a fresh `codex_all_data` volume with this Compose file and copy
the old CLI volume contents to `/data/cli`, Web contents to `/data/web`, and
workspace contents to `/data/workspace`, preserving UID/GID 1000 and file modes.
Do not mount an old CLI volume directly at `/data`: its files would be at the
wrong level. Start the new container, verify login/history and workspace files,
and retain the old volumes until the migration is confirmed. If using a bind
mount instead, supply one host directory writable by UID/GID 1000 at `/data`;
the image creates its subdirectories on first start.

The default `all-in-one-edge` tag follows successfully tested `main` commits.
Stable GitHub releases publish `all-in-one-<release-tag>` alongside the existing
Web image tag. Set `CODEX_ALL_IN_ONE_IMAGE` to a stable tag to keep a specific Web
build; neither tag updates a running container automatically. The CLI is pinned
inside both image types and is upgraded only with the supported image/test pin
after required integration checks. The image records its CLI version in the
`org.opencontainers.image.codex-cli-version` label.

Codex's inner Bubblewrap sandbox needs `seccomp=unconfined` and
`systempaths=unconfined` in the tested Docker setup. **These settings apply to
the entire all-in-one container, including the Web process.** The separate
Compose stack confines the Web container with Docker's defaults, so it remains
the recommended option when this separation matters. The all-in-one example
binds Web to loopback only. Use the optional login with HTTPS or a VPN before
making the UI reachable beyond a trusted network; anyone who can sign in can
operate Codex with the container's permissions. Hosts that disable unprivileged
user or mount namespaces can still block Bubblewrap despite these two Docker
options; check the host policy if CLI commands report namespace errors.

To build locally from the checked-out Web source, use
`docker build --target all-in-one -t codex-web:all-in-one .`. A plain
`docker build .` still builds the CLI-free Web image.

## Docker Hub publishing

The GitHub Actions workflow publishes releases and the current `main` branch to
`0to99/codex-web-docker` on Docker Hub for all supported platforms. Configure
these repository secrets:

- `DOCKER_USERNAME`
- `DOCKER_PASSWORD` (use a Docker Hub access token)

Publishing a GitHub release produces the release tag and the Docker metadata
action's matching tags, including `latest` for a stable semantic version.
The moving `edge` tag contains the latest successfully tested `main` commit.
Publishing starts after `main` has been quiet for 10 minutes; another push restarts
that wait and cancels the older publish run. The workflow runs the integration
and platform smoke tests once after the wait, then verifies that `main` still
points to the tested commit before building and pushing. A failed test leaves
the existing `edge` image in place. `edge` does not update running containers;
pull the new image and recreate the web container to use it.

### App-server image compatibility checks

Both companion images `0.164.0` and `0.155.1` are supported (`linux/amd64`).
Each has a required real-container integration case; failures in either block
release publication. The floating `latest` probe remains advisory.
The previous `0.155.1` baseline passed on 2026-10-18:
[validation run](https://github.com/0-99/codex-web-docker/actions/runs/39134630198).
This validates the covered local workflows. Shell-tool execution inside the
CLI sandbox, live account enrollment and known failures outside these flows
need separate regression cases; see the container sandbox configuration above.

The [standalone Compose example](examples/docker-compose.yml) pins `codex-cli`
to `ghcr.io/icoretech/codex-docker:0.164.0` by default and uses a shared Unix socket, also
required by the Mobile Connect fallback. See [setup](#docker-compose).

`test/integration/images.json` pins `supported-current` to version `0.164.0` and
`supported` to version `0.155.1`. CI runs both actual images through chat
creation, saved history, restart/reconnect, mobile layout, reload and the offline
pairing flow. The job summary reports its pulled digest and actual CLI version. CI also
checks the Compose CLI image pin, creates the configured tmpfs socket volume,
checks its permissions with default UID 1000, starts the actual listener and
checks both workspace aliases on a fresh named volume. Container integration
tests also apply the CLI security options from the example.
The separate `candidate` case probes a prospective update (initially `:latest`)
and is advisory. A candidate failure does not change the supported pin or any
deployment. Propose image upgrades by changing the candidate first, then promote
a verified version to the supported pin in a PR. Its required tests gate image
publication. Live OpenAI enrollment and phone sign-in remain outside the suite.
