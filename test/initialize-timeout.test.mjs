import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

// Exercise the method in the actual patched Desktop bundle. A bundle upgrade
// or a missing prepare_asar patch must fail this integration check.
const bundle = readFileSync("scratch/asar/.vite/build/src-Ct4P_yu5.js", "utf8");
const start = bundle.indexOf("    scheduleInitializeTimeout() {");
const end = bundle.indexOf("    clearInitializeTimeoutTimer() {", start);
assert.ok(
  start >= 0 && end > start,
  "locate the pinned Desktop timeout method",
);
function scheduledTimer(env, transport, hostId) {
  let timeout;
  const method = vm.runInNewContext(
    `({${bundle.slice(start, end)}}).scheduleInitializeTimeout`,
    {
      process: { env },
      gV: 30000,
      setTimeout(_callback, ms) {
        timeout = ms;
      },
    },
  );
  method.call({
    options: { transport: { kind: transport }, hostId },
    initializeStartedAtMs: 0,
    clearInitializeTimeoutTimer() {},
  });
  return timeout;
}
test("external local stdio proxy owns the initial wait without an upstream deadline", () => {
  assert.equal(
    scheduledTimer(
      { CODEX_APP_SERVER_URL: "ws://external:4500" },
      "stdio",
      "local",
    ),
    undefined,
  );
});
test("native and other host transports keep the upstream initialization deadline", () => {
  assert.equal(scheduledTimer({}, "stdio", "local"), 30000);
  assert.equal(
    scheduledTimer(
      { CODEX_APP_SERVER_URL: "ws://external:4500" },
      "websocket",
      "local",
    ),
    30000,
  );
  assert.equal(
    scheduledTimer(
      { CODEX_APP_SERVER_URL: "ws://external:4500" },
      "stdio",
      "remote",
    ),
    30000,
  );
});
