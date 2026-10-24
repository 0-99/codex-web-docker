# Chat failure investigation for Desktop 26.1007.30912

The production log from 2026-10-24 establishes that `spawn gh ENOENT` ended
the Web Node process. The runtime Dockerfile installs Node but neither `gh`
nor Git. The same log establishes two successful `thread/start` RPC replies;
it does not establish successful turns or rendered chats.

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

The pinned Desktop bundle could not be downloaded in this workspace because
the configured HTTP proxy was unreachable. The Docker socket also denied
access. GitHub Actions builds the actual Web runtime image and exercises saved
and new browser chats against CLI 0.155.1 with isolated synthetic test homes.
The test selects the saved chat through the sidebar, checks visible responses,
counts persistent threads, and verifies backend PID continuity. A delayed
new-chat action was observed to issue one persistent and one ephemeral
`thread/start`; the CLI listed one additional persistent thread.

Bundle inspection found the GitHub helper's `appServerClient.spawn` path and
its missing-command classification. The exact `gh --version` caller, the
`fs/readFile` call without `environmentId`, the `durable` host association,
MCP timeout behavior, and optional HTTP 403 behavior still need dedicated
investigation and regression coverage.
