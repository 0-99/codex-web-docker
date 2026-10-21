import assert from "node:assert/strict";
import test from "node:test";
import { fixtureCleanup } from "./integration/support.mjs";

test("integration cleanup stops writers before removing files and continues after errors", async () => {
  let after;
  const cleanup = fixtureCleanup({
    after: (callback) => {
      after = callback;
    },
  });
  const disposed = [];
  let appServerRunning = true;
  let backendRunning = true;
  const failure = new Error("browser cleanup failed");
  cleanup(() => {
    assert.equal(appServerRunning, false);
    assert.equal(backendRunning, false);
    disposed.push("files");
  });
  cleanup(() => {
    disposed.push("model");
  });
  cleanup(() => {
    appServerRunning = false;
    disposed.push("app-server");
  });
  cleanup(() => {
    backendRunning = false;
    disposed.push("backend");
  });
  cleanup(async () => {
    await Promise.resolve();
    disposed.push("browser");
    throw failure;
  });
  await assert.rejects(after, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure]);
    return true;
  });
  assert.deepEqual(disposed, [
    "browser",
    "backend",
    "app-server",
    "model",
    "files",
  ]);
});
