import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import runtime from "../src/server/web-runtime.js";
import { createStatusReporter } from "../docker/proxy-status.mjs";

async function start(t, enabled = true) {
  const previous = process.env.CODEX_APP_SERVER_URL;
  if (enabled) process.env.CODEX_APP_SERVER_URL = "ws://127.0.0.1:9";
  else delete process.env.CODEX_APP_SERVER_URL;
  const app = Fastify();
  t.after(async () => {
    await app.close();
    if (previous) process.env.CODEX_APP_SERVER_URL = previous;
    else delete process.env.CODEX_APP_SERVER_URL;
  });
  const html = await runtime.installWebRuntime(
    app,
    "/nested/app/",
    "<html><head></head><body></body></html>",
  );
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}/nested/app/`;
  return {
    app,
    html,
    base,
    snapshot: async () => (await fetch(base + "__backend/status")).json(),
  };
}
async function waitFor(snapshot, phase) {
  for (let i = 0; i < 100; i++) {
    const value = await snapshot();
    if (value.phase === phase) return value;
    await delay(10);
  }
  assert.fail(`status ${phase} was not received`);
}

test("reports backend readiness and serves fork assets beneath the configured base path", async (t) => {
  const f = await start(t);
  assert.match(f.html, /src="\/nested\/app\/__backend\/runtime.js"/);
  assert.equal((await f.snapshot()).phase, "backend-ready");
  const js = await fetch(f.base + "__backend/runtime.js");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /javascript/);
  assert.equal((await fetch(f.base + "__backend/runtime.css")).status, 200);
  assert.equal((await fetch(new URL("/__backend/status", f.base))).status, 404);
});

test(
  "private proxy events update JSON and SSE snapshots with a retry deadline",
  { timeout: 5000 },
  async (t) => {
    const f = await start(t);
    const events = await fetch(f.base + "__backend/status/events");
    const reader = events.body.getReader();
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /backend-ready/,
    );
    const reporter = createStatusReporter();
    t.after(() => reporter.close());
    const deadline = Date.now() + 30000;
    reporter.update("retry-wait", {
      attempt: 2,
      retryAt: deadline,
      secret: "must not be exposed",
    });
    const snapshot = await waitFor(f.snapshot, "retry-wait");
    assert.equal(snapshot.retryAt, deadline);
    assert.equal(snapshot.secret, undefined);
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /retry-wait/,
    );
    reporter.update("connected");
    reporter.update("resuming", { completed: 0, total: 2 });
    await waitFor(f.snapshot, "resuming");
    reporter.update("ready");
    const ready = await waitFor(f.snapshot, "ready");
    assert.ok(ready.history.some((item) => item.phase === "resuming"));
    reporter.close();
    await waitFor(f.snapshot, "failed");
    await reader.cancel();
  },
);

test(
  "status streams do not prevent graceful backend shutdown",
  { timeout: 3000 },
  async (t) => {
    const f = await start(t);
    const response = await fetch(f.base + "__backend/status/events");
    const reader = response.body.getReader();
    await reader.read();
    await f.app.close();
    assert.equal((await reader.read()).done, true);
  },
);

test("status UI is disabled for native mode without an external app-server", async (t) => {
  const f = await start(t, false);
  assert.equal((await f.snapshot()).enabled, false);
});

test("closing a proxy cannot hide another proxy that is still waiting", async (t) => {
  const f = await start(t);
  const waiting = createStatusReporter();
  const ready = createStatusReporter();
  const closing = createStatusReporter();
  t.after(() => {
    waiting.close();
    ready.close();
    closing.close();
  });
  waiting.update("retry-wait", { retryAt: Date.now() + 30000 });
  await waitFor(f.snapshot, "retry-wait");
  ready.update("ready");
  closing.update("ready");
  await delay(30);
  closing.close();
  await delay(30);
  assert.equal((await f.snapshot()).phase, "retry-wait");
  waiting.update("ready");
  await waitFor(f.snapshot, "ready");
});

test("unauthenticated reporters cannot change backend status", async (t) => {
  const f = await start(t);
  const [port] = process.env.CODEX_WEB_STATUS_ADDRESS.split(":");
  const socket = net.createConnection({
    host: "127.0.0.1",
    port: Number(port),
  });
  await once(socket, "connect");
  socket.write('{"token":"wrong"}\n{"phase":"ready"}\n');
  await once(socket, "close");
  assert.equal((await f.snapshot()).phase, "backend-ready");
});

test("malformed or oversized local status messages cannot corrupt the public snapshot", async (t) => {
  const f = await start(t);
  const [port, token] = process.env.CODEX_WEB_STATUS_ADDRESS.split(":");
  const socket = net.createConnection({
    host: "127.0.0.1",
    port: Number(port),
  });
  await once(socket, "connect");
  socket.write(JSON.stringify({ token }) + "\n");
  await delay(10);
  socket.write('not json\n{"phase":"invalid"}\n');
  socket.write("x".repeat(9000));
  await once(socket, "close");
  assert.equal((await f.snapshot()).phase, "failed");
});
