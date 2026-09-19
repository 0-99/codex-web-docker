import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";

async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail("condition did not become true");
}
async function fixture(t, handler, extraEnv = {}) {
  const requests = [];
  const outputs = [];
  const connections = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  let generation = 0;
  server.on("connection", (socket) => {
    const epoch = ++generation;
    connections.push(socket);
    let initialized = false;
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      requests.push({ ...message, epoch });
      if (message.method === "initialize") {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.method === "initialized") initialized = true;
      else {
        assert.ok(initialized, "initialized notification must precede RPC");
        const reply = (result, error) =>
          socket.send(
            JSON.stringify(
              error ? { id: message.id, error } : { id: message.id, result },
            ),
          );
        handler(message, { reply, epoch, socket });
      }
    });
  });
  await once(server, "listening");
  const child = spawn(
    process.execPath,
    ["docker/codex-app-server-proxy.mjs", "app-server"],
    {
      env: {
        ...process.env,
        CODEX_APP_SERVER_URL: `ws://127.0.0.1:${server.address().port}`,
        CODEX_APP_SERVER_RETRY_DELAYS_MS: "20",
        CODEX_APP_SERVER_HANDSHAKE_TIMEOUT_MS: "200",
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  readline
    .createInterface({ input: child.stdout })
    .on("line", (line) => outputs.push(JSON.parse(line)));
  t.after(async () => {
    child.kill();
    for (const socket of connections) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  let id = 0;
  const send = (method, params = {}) => {
    const requestId = ++id;
    child.stdin.write(JSON.stringify({ id: requestId, method, params }) + "\n");
    return requestId;
  };
  const response = async (requestId) => {
    await until(() => outputs.some((message) => message.id === requestId));
    return outputs.find((message) => message.id === requestId);
  };
  const call = (method, params) => response(send(method, params));
  await call("initialize");
  return {
    requests,
    outputs,
    connections,
    call,
    send,
    response,
    child,
    stderr: () => stderr,
  };
}

test(
  "resumes all active threads before queued turns after a restart",
  { timeout: 5000 },
  async (t) => {
    let nextThread = 0;
    const resumes = [];
    const f = await fixture(t, (request, { reply, epoch }) => {
      if (request.method === "thread/start")
        reply({ thread: { id: `thread-${++nextThread}` } });
      else if (request.method === "thread/resume")
        resumes.push({ reply, params: request.params });
      else reply({ epoch });
    });
    await f.call("thread/start", {
      cwd: "/workspace",
      config: { x: true },
      ephemeral: false,
      history: ["must not be replayed"],
    });
    await f.call("thread/start", { model: "example-model" });
    f.connections[0].terminate();
    await until(() => /reconnecting/.test(f.stderr()));
    const turn = f.send("turn/start", { threadId: "thread-1", input: [] });
    await until(() => resumes.length === 1);
    assert.deepEqual(resumes[0].params, {
      threadId: "thread-1",
      cwd: "/workspace",
      config: { x: true },
    });
    assert.equal(f.requests.filter((r) => r.method === "turn/start").length, 0);
    resumes[0].reply({ thread: { id: "thread-1" } });
    await until(() => resumes.length === 2);
    assert.equal(f.requests.filter((r) => r.method === "turn/start").length, 0);
    resumes[1].reply({ thread: { id: "thread-2" } });
    assert.deepEqual((await f.response(turn)).result, { epoch: 2 });
    assert.equal(
      f.outputs.filter((r) => r.id === 1).length,
      1,
      "initialize reply only once",
    );
    assert.ok(
      f.outputs.every((r) => !String(r.id).startsWith("codex-web-proxy:")),
    );
  },
);

test(
  "one missing thread does not prevent another thread from recovering",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, (request, { reply }) => {
      if (
        request.method === "thread/resume" &&
        request.params.threadId === "missing"
      )
        reply(null, { code: -1, message: "Thread not found" });
      else if (request.method === "thread/start")
        reply({ thread: { id: request.params.cwd } });
      else reply({ thread: { id: request.params.threadId }, ok: true });
    });
    await f.call("thread/start", { cwd: "missing" });
    await f.call("thread/start", { cwd: "good" });
    f.connections[0].terminate();
    await until(() => /reconnecting/.test(f.stderr()));
    assert.equal(
      (await f.call("turn/start", { threadId: "good" })).result.ok,
      true,
    );
    assert.match(
      (await f.call("turn/start", { threadId: "missing" })).error.message,
      /could not be restored/,
    );
    assert.equal(
      f.requests.filter(
        (r) => r.method === "turn/start" && r.params.threadId === "missing",
      ).length,
      0,
    );
  },
);

test(
  "in-flight mutating requests fail explicitly and are never replayed",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, (request, { reply, socket }) => {
      if (request.method === "turn/start") socket.terminate();
      else reply({});
    });
    const response = await f.call("turn/start", { threadId: "existing" });
    assert.match(response.error.message, /outcome is unknown/);
    await until(() => f.connections.length === 2);
    await f.call("thread/list");
    assert.equal(f.requests.filter((r) => r.method === "turn/start").length, 1);
  },
);

test(
  "disconnect during resume retries restoration before sending a waiting turn",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, (request, { reply, epoch, socket }) => {
      if (request.method === "thread/resume" && epoch === 2) socket.terminate();
      else reply({ thread: { id: "saved" }, epoch });
    });
    await f.call("thread/start");
    f.connections[0].terminate();
    await until(() => /reconnecting/.test(f.stderr()));
    assert.equal(
      (await f.call("turn/start", { threadId: "saved" })).result.epoch,
      3,
    );
    assert.equal(
      f.requests.filter((r) => r.method === "thread/resume").length,
      2,
    );
  },
);

test(
  "resume timeout reconnects instead of releasing unready requests",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(
      t,
      (request, { reply, epoch }) => {
        if (request.method !== "thread/resume" || epoch > 2)
          reply({ thread: { id: "saved" }, epoch });
      },
      { CODEX_APP_SERVER_RESUME_TIMEOUT_MS: "40" },
    );
    await f.call("thread/start");
    f.connections[0].terminate();
    await until(() => /reconnecting/.test(f.stderr()));
    assert.equal(
      (await f.call("turn/start", { threadId: "saved" })).result.epoch,
      3,
    );
  },
);

test(
  "unsubscribed threads are not restored; fork IDs and explicit resume are tracked",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, (request, { reply }) =>
      reply({
        thread: {
          id:
            request.method === "thread/fork"
              ? "fork"
              : request.params.threadId || "original",
        },
      }),
    );
    await f.call("thread/start");
    await f.call("thread/fork", { threadId: "original" });
    await f.call("thread/resume", { threadId: "saved", history: null });
    await f.call("thread/unsubscribe", { threadId: "original" });
    f.connections[0].terminate();
    await until(() => /reconnecting/.test(f.stderr()));
    await f.call("thread/list");
    assert.deepEqual(
      f.requests
        .filter((r) => r.epoch === 2 && r.method === "thread/resume")
        .map((r) => r.params.threadId),
      ["fork", "saved"],
    );
  },
);

test(
  "server-initiated requests can be answered during restoration",
  { timeout: 5000 },
  async (t) => {
    let resumeReply;
    const f = await fixture(t, (request, { reply, socket }) => {
      if (request.method === "thread/resume") {
        resumeReply = reply;
        socket.send(
          JSON.stringify({
            id: "server-request",
            method: "test/permission",
            params: {},
          }),
        );
      } else if (request.id === "server-request")
        resumeReply({ thread: { id: "saved" } });
      else reply({ thread: { id: "saved" } });
    });
    await f.call("thread/start");
    f.connections[0].terminate();
    await until(() => f.outputs.some((r) => r.id === "server-request"));
    f.child.stdin.write(
      JSON.stringify({ id: "server-request", result: {} }) + "\n",
    );
    assert.ok((await f.call("turn/start", { threadId: "saved" })).result);
  },
);
