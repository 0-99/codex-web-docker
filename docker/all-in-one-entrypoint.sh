#!/usr/bin/env bash
set -euo pipefail

socket=/run/codex/app-server.sock
rm -f "$socket"

(cd /workspace && exec codex app-server --listen "unix://$socket") &
cli_pid=$!

"$@" &
web_pid=$!

stop_children() {
  trap - TERM INT
  kill -TERM "$web_pid" "$cli_pid" 2>/dev/null || true
  wait "$web_pid" 2>/dev/null || true
  wait "$cli_pid" 2>/dev/null || true
}
trap stop_children TERM INT

set +e
wait -n "$web_pid" "$cli_pid"
status=$?
set -e
stop_children

# Either service stopping cleanly while the container is running still requires
# a container restart, so it must not look like a successful shutdown.
if [ "$status" -eq 0 ]; then
  exit 1
fi
exit "$status"
