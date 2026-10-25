# Chat failure investigation for Desktop 26.1007.30912

The production log from 2026-10-24 establishes that `spawn gh ENOENT` ended
the Web Node process. The runtime Dockerfile installs Node but neither `gh`
nor Git. The same log establishes two successful `thread/start` RPC replies;
it does not establish successful turns or rendered chats.

A read-only reproduction on 2026-10-25 narrows the trigger. The landing page
and an unsent new-chat composer stayed available. Opening a saved chat logged
`thread_resume_requested`, then a successful `thread/read` reply at
12:14:42.624 UTC, followed by `spawn gh ENOENT` at 12:14:42.745 UTC.
The Web container restarted repeatedly (restart count 3 to 8), while the CLI
container did not restart. Subsequent resume attempts preceded the same
missing-command crash. This establishes the failure sequence for opening a
saved chat; the exact Desktop function that initiates the version probe is
still not identified. No `turn/start` was exercised in that production run.

This patch confines optional command handling to modules loaded from the
Desktop bundle. A missing `gh` or `git` now produces a normal child exit with
status 127 and an explanatory `command not found` stderr message for `spawn`
and `execFile` callers. The pinned Desktop GitHub helper checks both the exit
code and that phrase to classify the executable as missing. An installed tool
keeps its original result. The IPC invoke bridge also converts a synchronous
Desktop handler exception into an error reply.
Neither layer grants GitHub capability or fabricates a successful version.

The local app-server relay records only selected RPC method names, `local`
host, transport, queue wait, elapsed time, completion state and numeric error
code when `CODEX_WEB_RPC_TRACE_FILE` names a writable file. Desktop treats
proxy stderr as a connection error, so routine RPC traces must not use stderr.
The trace records neither RPC parameters nor response bodies. Its in-flight
requests remain single-use across reconnects; failed requests report an
unknown outcome and are not replayed.

After a forwarded chat RPC remains unanswered for five seconds, the status
panel identifies the pending action without showing request data. An RPC error
is shown with its numeric code for ten seconds. These states do not cancel or
retry the request. A successful `turn/start` reply only acknowledges the turn;
the relay keeps a separate waiting state until `turn/completed`, including while
an MCP server times out. The built-image browser test delays `thread/start` for
25 seconds and configures a synthetic MCP server whose handshake exceeds its
startup deadline.

The status panel distinguishes a relay that vanished from a relay that stopped
after its configured reconnect limit. The default retry policy has no limit;
the older generic "connection stopped" label alone did not establish which
event happened on the affected machine.

The pinned Desktop bundle could not be downloaded in this workspace because
the configured HTTP proxy was unreachable. The Docker socket also denied
access. GitHub Actions builds the actual Web runtime image and exercises saved
and new browser chats against CLI 0.155.1 with isolated synthetic test homes.
The test selects the saved chat through the sidebar, checks visible responses,
counts persistent threads, and verifies backend PID continuity. A delayed
new-chat action was observed to issue one persistent and one ephemeral
`thread/start`; the CLI listed one additional persistent thread.

Bundle inspection found the GitHub helper's `appServerClient.spawn` path and
its missing-command classification. The saved-chat action that precedes
`gh --version` is now reproduced; its precise Desktop call chain remains
unmapped. The `fs/readFile` call without `environmentId`, the `durable` host
association, and optional HTTP 403 behavior still need dedicated investigation
and regression coverage. The local relay can record content-free `fs/readFile`
timings; it does not see the separate durable connection.

The affected Web container had no retry overrides. Its source defaults retry
the app-server connection indefinitely, and no `giving up` log was found.
The observed "connection stopped" label followed Web process restarts; it
does not establish exhausted relay retries or a CLI container failure.

The bundle has more than one `fs/readFile` caller: plugin manifest loading,
attachment registry state, and executor file access. The executor path adds
its own `environmentId`; the observed protocol error has not been tied to one
of these callers. The relay therefore preserves an environment error instead
of guessing an ID or reading a local file. Local thread read and turn requests
are checked against the same local gateway in the browser test.

`/accounts/optimized/check` participates in workspace selection, so an HTTP
403 cannot be treated as a successful check. The routing regression explicitly
rejects a Cloudflare-style 403. The observed 403s on optional cloud features
such as automations and subscriptions have not been reproduced with the
synthetic local account; their effect on a production ChatGPT session remains
open.
