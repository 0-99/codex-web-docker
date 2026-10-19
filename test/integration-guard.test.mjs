import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { appServerFixture } from "./integration/support.mjs";

test("real integration fixtures refuse execution without explicit network isolation", async () => {
  const previous = process.env.CODEX_TEST_NETWORK_ISOLATED;
  delete process.env.CODEX_TEST_NETWORK_ISOLATED;
  try {
    await assert.rejects(
      appServerFixture(),
      /Real integrations require an isolated network namespace/,
    );
  } finally {
    if (previous === undefined) delete process.env.CODEX_TEST_NETWORK_ISOLATED;
    else process.env.CODEX_TEST_NETWORK_ISOLATED = previous;
  }
});

test("an isolation flag cannot enable integrations while an external interface exists", async () => {
  const previous = process.env.CODEX_TEST_NETWORK_ISOLATED;
  const interfaces = os.networkInterfaces;
  process.env.CODEX_TEST_NETWORK_ISOLATED = "1";
  os.networkInterfaces = () => ({ lo: [], eth0: [] });
  try {
    await assert.rejects(appServerFixture(), /Only loopback may exist/);
  } finally {
    os.networkInterfaces = interfaces;
    if (previous === undefined) delete process.env.CODEX_TEST_NETWORK_ISOLATED;
    else process.env.CODEX_TEST_NETWORK_ISOLATED = previous;
  }
});
