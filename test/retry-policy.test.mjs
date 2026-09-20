import assert from "node:assert/strict";
import test from "node:test";
import { retryPolicy } from "../docker/retry-policy.mjs";

test("default schedule repeats 30 seconds indefinitely", () => {
  const policy = retryPolicy({});
  assert.deepEqual(
    [1, 2, 3, 4, 5, 10000].map((n) => policy.next(n).delay),
    [10000, 10000, 20000, 30000, 30000, 30000],
  );
});
test("custom schedule, optional limit and reset are deterministic", () => {
  const policy = retryPolicy({
    CODEX_APP_SERVER_RETRY_DELAYS_MS: "10, 20",
    CODEX_APP_SERVER_RETRY_MAX_ATTEMPTS: "3",
  });
  assert.deepEqual(
    [1, 2, 3].map((n) => policy.next(n).delay),
    [10, 20, 20],
  );
  assert.equal(policy.next(4), null);
  assert.equal(policy.next(1).delay, 10);
});
test("explicit legacy settings retain their finite phases and warn", () => {
  const warnings = [];
  const policy = retryPolicy(
    {
      CODEX_APP_SERVER_RECONNECT_ATTEMPTS: "1",
      CODEX_APP_SERVER_RECONNECT_BACKOFF_ATTEMPTS: "2",
    },
    (m) => warnings.push(m),
  );
  assert.deepEqual(
    [1, 2, 3].map((n) => policy.next(n).delay),
    [30000, 300000, 600000],
  );
  assert.equal(policy.next(4), null);
  assert.equal(warnings.length, 1);
});
test("new settings override deprecated ones including invalid old values", () => {
  const policy = retryPolicy({
    CODEX_APP_SERVER_RETRY_DELAYS_MS: "42",
    CODEX_APP_SERVER_RECONNECT_ATTEMPTS: "invalid",
  });
  assert.equal(policy.next(200).delay, 42);
});
test("invalid settings never overflow a Node timer into a retry storm", () => {
  for (const value of [
    "0",
    "-1",
    "1.5",
    "NaN",
    "Infinity",
    "2147483648",
    "10,,20",
  ]) {
    assert.throws(() =>
      retryPolicy({ CODEX_APP_SERVER_RETRY_DELAYS_MS: value }),
    );
  }
  assert.throws(() =>
    retryPolicy({ CODEX_APP_SERVER_RETRY_MAX_ATTEMPTS: "-1" }),
  );
  assert.throws(() =>
    retryPolicy({
      CODEX_APP_SERVER_RECONNECT_BACKOFF_INCREMENT_MS: "2147483647",
    }),
  );
});
