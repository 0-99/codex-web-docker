# architecture

a bit on how this whole thing is put together.

the general approach here is to download the electron app, unpack it and apply
as small a set of patches to it as possible to get it working.

an electron app has two parts, a part which runs in the main process and a part
which runs in the renderer process.

the main process part is basically a node process with a `require('electron')`
dependency. it runs even before anything is visible on the screen, setting up
the system tray widget, running background tasks and hooking up listeners for
app launcher events. there is a single instance of the main process regardless
of how many windows are open.

the ui runs inside an electron renderer process. in the desktop app, this looks
sorta like a browser with some modifications to the browser's chrome. it handles
displaying the interface, reacting to events from user interaction and holding
onto state which lives close to the ui (what text is in the prompt box for
example).

the electron renderer process usually launched by the electron main process. the
main process and render process communicate via an IPC setup in a [preload
script]. the preload script is injected into the renderer process before
anything else loads, has privileged access and can expose functions and data to
the renderer realm through `contextBridge.exposeInMainWorld`. the preload script
has access to [`ipcRenderer`].

codex-web hooks the preload script by providing [shim.ts](./src/browser/shim.ts)
as a stand-in for electron in the renderer process and then setting up preload
to run in the renderer realm (see
[vite.browser.config.ts](./vite.browser.config.ts)).

next, we apply a series of patches to both code running in the main process and
the renderer process. these are applied at postinstall time through the
[`prepare_asar`](./scripts/prepare_asar) script. patches are located
in [./patches](./patches) and applied ontop of the prettified code extracted
from the upstream app. care was taken here to patch at installation time to
avoid redistributing the original code.
the [./patches/webview-preload.patch](patches/webview-preload.patch) connects
the shimmed preload script to the index.html entrypoint.

we aim for the patches to be as small as possible as they're the most annoying
part to change. the patches today are mostly around routing, urls, page title,
pwa and mobile behavior.

to connect the ipc from the renderer process to the main process, we use a
websocket for most messages intercepting and handing a small handful of messages
directly (file picker, workspace picker). today, the remaining parts of shim are
for connecting the in memory router to the browser history and setting up the
sidebar behavior on mobile.

the ipc websocket is hosted by [main.ts](./src/server/main.ts). this process
binds a port and listens for incoming websocket connections. it also shims
electron (see `installModuleAliasHook`) before loading the electron shell
entrypoint. the shims are located in
[./src/server/electron](./src/server/electron) and focus on providing the
minimum amount of functionality needed to make the app work. this comes down to
some network transport to the outside world and hooking up to the ipc pipe from
the renderer. this part is the most sloppy part of the codebase as i left codex
to figure it out unattended. the parts around `__codexElectronIpcBridge` are the
important bits related to wiring up the ipc bridge.

[preload script]: https://www.electronjs.org/docs/latest/tutorial/tutorial-preload
[`ipcRenderer`]: https://www.electronjs.org/docs/latest/api/ipc-renderer

## Docker/web fork extension boundary

The Docker fork keeps connection policy and browser adaptations outside the
extracted Desktop application. Do not fold these modules into Desktop bundles.

| Location | Responsibility |
| --- | --- |
| `docker/codex-app-server-proxy.mjs` | JSONL/WebSocket bridge, connection generations, outstanding requests and thread recovery |
| `docker/retry-policy.mjs` | New retry schedule and deprecated environment compatibility |
| `docker/proxy-status.mjs` | Private status reporting; stdout stays exclusively app-server RPC |
| `src/server/web-runtime.ts` | Status aggregation, JSON/SSE endpoints and injection of fork-owned browser assets |
| `docker/browser/runtime.js` / `runtime.css` | Startup/reconnect panel, countdown and mobile visual viewport sizing |
| `src/server/electron/locale.ts` | Request-scoped browser locale and system fallback |
| `patches/app-server-initialize-timeout.patch` | Small local-stdio guard: the external proxy owns its initialization deadline |

`main.ts` installs the extension and wraps IPC dispatch with a browser-language
context. The Electron shim reads that context without overwriting settings;
Desktop still resolves `localeOverride`. No new webview patch is needed for
status or mobile layout. The timeout patch is the only modified extracted-code
patch for this feature set.

Each proxy reports states over an authenticated loopback TCP connection created
by the backend. Its ephemeral port and random token are inherited through
`CODEX_WEB_STATUS_ADDRESS`, never included in the public status snapshot.
Status clients receive only phases, counts and timing, not RPC payloads or
thread contents. Backend availability and app-server readiness remain distinct.

Recovery initializes each new transport, resumes active threads, and only then
releases queued requests. Already-sent requests are failed rather than replayed;
server-request responses from an old transport are discarded. A failed resume
isolates that thread instead of blocking healthy threads. The associated tests
use independently restarted mock WebSocket servers and check ordering.
