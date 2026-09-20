import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { format } from "prettier";

// Verify the pinned Desktop's native waiting behavior. No fork timeout patch
// is needed while the actual local-host factory enables this upstream option.
// This bundle no longer needs a patch, so prepare_asar leaves it minified.
const bundle = await format(
  readFileSync("scratch/asar/.vite/build/src-VqXTPopo.js", "utf8"),
  { parser: "babel" },
);
const main = readFileSync("scratch/asar/.vite/build/main-C5K7o1Hr.js", "utf8");
assert.match(main, /var W = `local`/);
assert.match(main, /continueWaitingForStdioInitializeTimeout: t.id === W/);
const start = bundle.indexOf("    scheduleInitializeTimeout() {");
const end = bundle.indexOf("    clearInitializeTimeoutTimer() {", start);
assert.ok(
  start >= 0 && end > start,
  "locate the pinned Desktop timeout method",
);
const deadline = Number(bundle.match(/\bxJ = ([\deE.+-]+)/)?.[1]);
assert.equal(deadline, 30000);

function expireDeadline(transport, hostId, hostKind = "local") {
  let callback;
  const effects = { rejected: 0, reported: 0, states: [] };
  const method = vm.runInNewContext(
    `({${bundle.slice(start, end)}}).scheduleInitializeTimeout`,
    {
      xJ: deadline,
      mK: "initialize",
      xW: "initialize timed out",
      CW: "timeout",
      setTimeout(fn, ms) {
        assert.equal(ms, deadline);
        callback = fn;
      },
    },
  );
  method.call({
    options: {
      transport: { kind: transport },
      hostId,
      hostConfig: { kind: hostKind },
      continueWaitingForStdioInitializeTimeout: hostId === "local",
      errorReporter: {
        reportNonFatal() {
          effects.reported++;
        },
      },
    },
    initializeStartedAtMs: 0,
    initialized: false,
    resolveInitialize() {},
    rejectInitialize() {
      effects.rejected++;
    },
    clearInitializeTimeoutTimer() {},
    logger: { warning() {} },
    getInitializeDurationMs: () => deadline,
    clientRequestQueue: new Map(),
    internalResponseHandlers: new Map(),
    getRetryDisplayState: () => "reconnecting",
    setConnectionState(state) {
      effects.states.push(state);
    },
  });
  assert.equal(typeof callback, "function");
  callback();
  return effects;
}

test("upstream local stdio initialization keeps waiting after its reporting deadline", () => {
  assert.deepEqual(expireDeadline("stdio", "local"), {
    rejected: 0,
    reported: 1,
    states: [],
  });
});

test("other transports and remote hosts retain upstream initialization failure behavior", () => {
  for (const [transport, host] of [
    ["websocket", "local"],
    ["stdio", "remote"],
  ]) {
    assert.deepEqual(expireDeadline(transport, host), {
      rejected: 1,
      reported: 0,
      states: ["reconnecting"],
    });
  }
  assert.deepEqual(expireDeadline("stdio", "local", "remote-control"), {
    rejected: 0,
    reported: 0,
    states: ["error"],
  });
});
