import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import electron from "../src/server/electron/index.js";

test("Electron user data and derived state paths use the configured directory", () => {
  const previous = process.env.CODEX_WEB_USER_DATA_DIR;
  const configured = path.resolve("test-user-data");
  process.env.CODEX_WEB_USER_DATA_DIR = configured;

  try {
    assert.equal(electron.app.getPath("userData"), configured);
    assert.equal(electron.app.getPath("sessionData"), configured);
    assert.equal(electron.app.getPath("logs"), path.join(configured, "logs"));
    assert.equal(
      electron.app.getPath("crashDumps"),
      path.join(configured, "Crashpad"),
    );
  } finally {
    if (previous) process.env.CODEX_WEB_USER_DATA_DIR = previous;
    else delete process.env.CODEX_WEB_USER_DATA_DIR;
  }
});

test("Electron setPath overrides an individual path", () => {
  const original = electron.app.getPath("logs");
  const override = path.resolve("test-logs");

  electron.app.setPath("logs", override);
  assert.equal(electron.app.getPath("logs"), override);

  electron.app.setPath("logs", original);
});
