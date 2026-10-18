# upgrading

instructions for upgrading codex-web to point at a new version of upstream
Codex Desktop.

## backing up

we will start by generating a scratch directory and backing it up. first, let's
get the `scratch` directory to a known state by running the following

```bash
rm -rf scratch scratch-backup # remove existing past scratch directories to start from clean state
DEV=1 nix develop --command yarn run prepare:asar 
mv scratch scratch-backup
```

the `scratch-backup` directory holds the patched, working version of codex-web.
we will use this when moving the patches over to the new version to understand
the context the patches were being applied in.

## updating urls

there are a few places to update next.

1. `appVersion` in default.nix and `hash` in `codexZip`.
2. `APP_VERSION` in ./scripts/prepare

then temporarily comment out the patch lines in ./scripts/prepare_asar and run

```bash
DEV=1 nix develop --command yarn run prepare:asar 
cp -r scratch scratch-new-version-unmodified
```

## upgrading the codex-cli version

this part can be run concurrently with the rest of the upgrade process. make
sure to wait for its completion before doing validation. run it in a subagent.

run the following to get the version of the new codex-cli

```bash
scratch/ChatGPT.app/Contents/Resources/codex-cli/bin/codex --version
```

then update the `nix/codex/default.nix` file's `version` field and hashes to
point to the new version.

## porting over patches

now we have a few folders

* `scratch-backup`: patches applied on top of old version of Codex Desktop
* `scratch-new-version-unmodified`: plain extracted new version of Codex Desktop
* `scratch`: working copy we will be modifying

now carefully look at the patches in `patches/` and how they were applied in
`scratch-backup` and bring the changes over to `scratch`. apply them directly
in-tree first. don't worry immediately about updating the patches yet.

## updating patches

once the patches have been made in `scratch`, diff the changes in `scratch`
against `scratch-new-version-unmodified` and update the patches in `patches/`.
always generate the patches by running `diff` and always avoid writing the
patches manually as it's very easy to get them wrong.

once that is done, uncomment the patch lines in `scripts/prepare_asar` and run

```bash
mv scratch scratch-patched-inplace
rm -rf scratch
DEV=1 nix develop --command yarn run prepare:asar 
```

then diff `./scratch-patched-inplace` with the resulting `./scratch` to validate
the patches were applied as expected.

## validation

After preparing the extracted application, run `npm test`,
`npm run build:browser` and `npm run test:browser-runtime`. Require the
**Test real Desktop and app-server offline** workflow for both CLI versions and
all Docker platform checks before merging. The integration workflow completes
the real browser flows automatically; its failure artifacts contain the screen
and HTML needed to investigate failures. See the offline CI description below
for coverage and the external services it simulates.

A manual browser or phone session is useful for diagnosing an external account
or device problem, but is not a recurring release check. Keep failed checks
blocking until their cause is resolved.

## Maintaining this Docker/web fork

Before merging `0xcaff/codex-web`, start from an up-to-date fork `main` on a
separate branch. Review the extension-boundary table in `ARCHITECTURE.md` and
preserve `docker/`, `examples/` and `DOCKER.md` as fork-owned files. Keep edits to
upstream source files limited to their integration points. Do not include an
unrelated Codex Desktop/CLI version upgrade in a feature change.

For the external app-server integration, verify these invariants after a merge:

1. `main.ts` still installs `installWebRuntime` and serves injected assets at the
   configured base path, including direct links to nested routes.
2. Browser IPC advertises `navigator.languages`; dispatch runs within the locale
   context and the Electron locale methods use it. Upstream's explicit
   `localeOverride` must remain authoritative.
3. Verify that the actual local-host factory enables
   `continueWaitingForStdioInitializeTimeout` and the timeout callback keeps
   initialization pending. The former fork timeout patch is no longer needed.
   Port `test/initialize-timeout.test.mjs` to the new bundles, including its
   checks of other transports. Do not disable upstream deadlines globally.
4. Check the pinned app-server protocol for `initialize` + `initialized`,
   `thread/resume` parameters and thread lifecycle notifications. Preserve
   session configuration without replaying start/fork/history payloads.
5. Require the **Test real Desktop and app-server offline** workflow. It opens
   the actual extracted Desktop in Playwright, rather than a modeled layout,
   and exercises persisted chats, mobile resizing, process restart recovery
   and the real connection screen's pairing action.
6. Release publication also calls that workflow. Both binary CLI versions, the supported container image and all
   Docker platform checks must pass before the image publishing job can run.
   Routine updates do not require repeating manual phone checks.

Validation (after preparing the extracted application):

```sh
npm test
npm run build:browser
npx playwright install chromium
npm run test:browser-runtime
```

`npm test` covers proxy recovery, retry configuration, locale isolation, status
transport/SSE and existing base-path behavior. Browser tests cover visible
countdowns, recovery, draft preservation and mobile/desktop viewport sizing in
a small chat-layout fixture. Docker CI additionally builds every supported
architecture, checks initialization with an unavailable app-server, verifies
finite retry exhaustion, and creates/reuses a fresh named Codex-home volume.

### Offline integration CI

The required container baseline is recorded in `test/integration/images.json`:
`ghcr.io/icoretech/codex-docker:0.155.1`. The workflow executes the pulled image
with its normal entrypoint and verifies `codex-cli 0.155.1`; it does not extract
and substitute a host binary. The job summary records the immutable digest and
reported CLI version. The image runs as the runner UID with a fresh test home
and the repository mounted at the identical absolute path.

The same file defines a separate upgrade candidate, initially `:latest`. That
matrix case is explicitly advisory (`continue-on-error`) because newer images
may be incompatible. Its failure remains visible in its job, diagnostics and
summary, but does not invalidate the supported baseline or promote the image.
To propose an update, set a candidate tag, review its results, then change the
supported image and expected CLI version in a PR; update the optional service
in `examples/docker-compose.yml` and the README reference at the same time.
CI validates the Compose file with the app-server profile enabled. The supported case must pass
before Docker publication. Never replace the supported tag with `latest`.

Container cases create a network namespace using a Docker container with
`--network none`. The host test runner joins that namespace; each actual CLI
container joins it too. Only loopback connects the CLI, local model fixture and
browser/backend. Docker's daemon remains outside the namespace for lifecycle
operations, and downloaded images are referenced by digest during execution.
A restart stops the real CLI container and launches another with the same test
home so the persistence checks also cover container lifecycle. Container cases
use the real CLI Unix listener, matching the Compose service and exercising
owner-only socket access. The Compose helper initializes the dedicated socket
volume for UID 1000 in both runtime images; account homes stay separate.


`.github/workflows/integration.yml` prepares the actual Desktop and downloads
checksum-pinned CLI packages for the previous distinct version from Git history
and the current version read from `nix/codex/default.nix`. Both pins and hashes
follow version upgrades automatically. It then starts a new Linux
network namespace with loopback as its only interface. Tests fail closed if
they are invoked without that isolation. Downloads and browser installation
happen before entering the namespace; test execution has no internet access.

The real app-server uses a fresh test-only Codex home, a dummy local credential
and a local Responses API fixture. Tests create a persistent conversation,
complete a turn, stop and restart the app-server process, check the retained
history and continue the same thread. No production account or paid model is
used. The browser test loads the real Desktop beneath a nested base path,
resumes saved history, sends a turn and checks mobile composer sizing and draft
preservation through reconnect. Failures retain screenshots and HTML in the CI
artifact.

The pairing gateway forwards normal requests to the real CLI, while replacing
only cloud enrollment and pairing-code creation with deterministic replies.
Playwright must find the action in the actual connection screen and display the
returned code. This covers our observer, HTTP route, same-origin request and
Unix/WebSocket RPC path. It does not sign a real phone into ChatGPT or validate
OpenAI's enrollment service. A real device check is needed only when diagnosing
that external flow or changing its protocol, not as a recurring release gate.

Do not publish a release as part of validation. Submit the branch as a pull
request and review its checks before merging or creating a release separately.

### Upstream upgrade completed on 2026-09-20

The earlier audit used common ancestor `8cc728d` and fork baseline `d6c244d`.
Both that baseline and the runtime feature branch conflicted with upstream
`0dfdc10` in `src/server/main.ts`. The merge includes that upstream revision
as a merge parent, including Desktop `26.901.41123`,
the upstream CLI pin `0.153.3`, and per-tab renderer ownership.

The merge retains our base-path setup while taking upstream's renderer factory,
message-port buffering, tab isolation and browser IPC reconnect behavior. The
entire asynchronous IPC dispatch stays inside `withBrowserLanguages`, including
the `rendererReady` wait. Tests verify isolated replies, new renderer IDs after
reconnect, early MessagePort delivery and browser locale isolation.

The new Desktop already enables `continueWaitingForStdioInitializeTimeout` for
the local host. The former `app-server-initialize-timeout.patch` and its prepare
hook have therefore been removed. The regression test executes the actual
upstream timeout callback and verifies its local-host factory setting. There
are no fork-only extracted-code patches left from this feature set.

The new CLI schema was checked for `thread/resume`. Creation-only `serviceName`
is no longer forwarded; `serviceTier` and `runtimeWorkspaceRoots` are retained.
The Docker image still excludes the CLI: its app-server is deployed separately.
A real CLI initialization handshake was checked locally; starting a real thread
requires sandbox facilities unavailable in this work environment. Thread
recovery ordering, retries and failure handling are covered by mock-server tests.

For each future candidate, perform a read-only merge probe without changing
the working tree or index:

```sh
git fetch upstream main
git merge-tree --write-tree HEAD upstream/main
```

Configure `upstream` as `https://github.com/0xcaff/codex-web.git` if it does not
exist. Exit status 1 identifies merge conflicts; a successful textual merge does
not validate Desktop patches or runtime behavior. Run the validation steps above
after resolving and preparing the upgrade branch.

### Upstream upgrade candidate prepared on 2026-10-18

This candidate merges upstream `2424e85` (2026-10-15), including Desktop
`26.1007.30912`, the Nix-only CLI pin `0.162.0-alpha.17.2`, reconnect shim fixes
and the Statsig bootstrap retry limit. The CLI-free Docker build still connects
to an independently versioned app-server; no Compose settings or volumes change.

The two source conflicts were resolved by retaining the fork's asset injection,
locale context and server return value while taking the upstream package
entrypoint, which initializes network policy before app startup. Both the
build-revision patch and upstream bootstrap retry patch remain in prepare_asar.

The Desktop tool integration now uses separate plugin and legacy override
factories. Guard those factories only: replacing the entire transport override
list would also discard the new authentication and workspace settings. The
regression tests execute the patched factories and verify those other settings
survive. The build-revision item has moved into the new profile Help submenu.

The connection screen now also has a **Set up** state, and the English empty
state says **Add device**. The pairing observer and browser fixture cover those
states in English and German. The actual Desktop test also covers the new
app-shell root, whose inline `100svh` height replaces the earlier viewport
class on this route. The fork overrides both wrappers with the visual viewport
height; the CI test verifies that the actual composer follows it.

The experimental schema generated by CLI `0.162.0-alpha.17.2` retains the proxy's
thread-resume configuration fields and the remote-control enable/pairing
requests. The offline real-CLI integration workflow supplements this schema
check with persisted conversations and process restart recovery on both tested
versions. Compatibility with other CLI versions is outside that test matrix.
