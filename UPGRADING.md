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
scratch/ChatGPT.app/Contents/Resources/codex --version
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

to validate things are still working, we'll first validate the server, then the
client. before starting this step, make sure to wait for the
`upgrading the codex-cli version` subagent to finish.

to validate the server, run the following

```bash
nix develop --command yarn server
```

next validate the client by opening a browser window to `http://localhost:8214`
and validating things show up on the page.

look in the console for errors. also, look on the screen to see whether any
error dialogs popped up. sometimes errors occur, but they're silent and exhibit
as loading taking forever (more than 1m). look out for that case too.

if there are errors, bring them to the users attention and we will decide how to
proceed.

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
3. Regenerate `app-server-initialize-timeout.patch` using `diff` against the
   prettified original. Its guard only applies to the external local stdio
   proxy; do not disable upstream native/remote-control timeouts globally.
4. Check the pinned app-server protocol for `initialize` + `initialized`,
   `thread/resume` parameters and thread lifecycle notifications. Preserve
   session configuration without replaying start/fork/history payloads.
5. Inspect the real Desktop root/chat layout when changing viewport-related
   selectors. The browser regression fixture checks viewport behavior, but a
   real Android/iOS keyboard remains a useful deployment smoke check.

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

Do not publish a release as part of validation. Submit the branch as a pull
request and review its checks before merging or creating a release separately.
