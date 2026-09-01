import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const proxyPath = path.join(
  repositoryRoot,
  "docker",
  "codex-app-server-proxy.mjs",
);

function echoConnections(server) {
  const connections = new Set();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("message", (data) => {
      const message = data.toString();
      const parsedMessage = JSON.parse(message);
      if (parsedMessage.method === "initialize") {
        socket.send(JSON.stringify({ id: parsedMessage.id, result: {} }));
        return;
      }
      socket.send(message);
    });
  });
  return connections;
}

function capture(stream) {
  let output = "";
  const waiters = new Set();

  stream.on("data", (chunk) => {
    output += chunk.toString();
    for (const waiter of waiters) {
      if (waiter.pattern.test(output)) {
        clearTimeout(waiter.timeout);
        waiters.delete(waiter);
        waiter.resolve(output);
      }
    }
  });

  return {
    output: () => output,
    waitFor(pattern, timeoutMs = 2_000) {
      if (pattern.test(output)) {
        return Promise.resolve(output);
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          pattern,
          resolve,
          timeout: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`timed out waiting for ${pattern}: ${output}`));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
  };
}

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

function spawnProxy(t, endpoint, additionalEnv = {}) {
  const child = spawn(
    process.execPath,
    [proxyPath, "-c", "features.code_mode_host=true", "app-server"],
    {
      env: {
        ...process.env,
        CODEX_APP_SERVER_URL: endpoint,
        ...additionalEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  t.after(() => child.kill());
  return child;
}

async function assertBridge(t, endpoint) {
  const child = spawnProxy(t, endpoint);

  const output = readline.createInterface({ input: child.stdout });
  const initializeResponse = once(output, "line");
  child.stdin.write(
    `${JSON.stringify({ id: "init", method: "initialize" })}\n`,
  );
  assert.deepEqual(JSON.parse((await initializeResponse)[0]), {
    id: "init",
    result: {},
  });

  const response = once(output, "line");
  const request = JSON.stringify({ id: 1, method: "thread/list" });
  child.stdin.write(`${request}\n`);
  assert.equal((await response)[0], request);
  child.stdin.end();
  assert.equal((await once(child, "exit"))[0], 0);
}

test("bridges JSONL stdio to a WebSocket app-server", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  echoConnections(server);
  await once(server, "listening");

  const address = server.address();
  assert.equal(typeof address, "object");
  await assertBridge(t, `ws://127.0.0.1:${address.port}`);
});

test("reconnects after the app-server becomes available", async (t) => {
  const port = await unusedPort();
  const child = spawnProxy(t, `ws://127.0.0.1:${port}`, {
    CODEX_APP_SERVER_HANDSHAKE_TIMEOUT_MS: "100",
    CODEX_APP_SERVER_RECONNECT_ATTEMPTS: "5",
    CODEX_APP_SERVER_RECONNECT_DELAY_MS: "100",
  });
  const stderr = capture(child.stderr);
  const output = readline.createInterface({ input: child.stdout });
  const initializeResponse = once(output, "line");
  child.stdin.write(
    `${JSON.stringify({ id: "init", method: "initialize" })}\n`,
  );
  await stderr.waitFor(/quick attempt 1\/5/);

  const server = new WebSocketServer({ host: "127.0.0.1", port });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  echoConnections(server);
  await once(server, "listening");

  assert.deepEqual(JSON.parse((await initializeResponse)[0]), {
    id: "init",
    result: {},
  });
  assert.match(
    stderr.output(),
    /app-server connection established after quick attempt 1\/5/,
  );
  const response = once(output, "line");
  const request = JSON.stringify({ id: 2, method: "thread/list" });
  child.stdin.write(`${request}\n`);

  assert.equal((await response)[0], request);
  child.stdin.end();
  assert.equal((await once(child, "exit"))[0], 0);
});

test("reinitializes after an established connection is lost", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const connections = echoConnections(server);
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");

  const child = spawnProxy(t, `ws://127.0.0.1:${address.port}`, {
    CODEX_APP_SERVER_HANDSHAKE_TIMEOUT_MS: "100",
    CODEX_APP_SERVER_RECONNECT_ATTEMPTS: "5",
    CODEX_APP_SERVER_RECONNECT_DELAY_MS: "100",
  });
  const stderr = capture(child.stderr);
  const output = readline.createInterface({ input: child.stdout });
  const initializeResponse = once(output, "line");
  child.stdin.write(
    `${JSON.stringify({ id: "init", method: "initialize" })}\n`,
  );
  assert.deepEqual(JSON.parse((await initializeResponse)[0]), {
    id: "init",
    result: {},
  });

  assert.equal(connections.size, 1);
  connections.values().next().value.terminate();
  await stderr.waitFor(/quick attempt 1\/5/);

  const response = once(output, "line");
  const request = JSON.stringify({ id: 3, method: "thread/list" });
  child.stdin.write(`${request}\n`);
  assert.equal((await response)[0], request);
  assert.match(
    stderr.output(),
    /app-server connection restored after quick attempt 1\/5/,
  );

  child.stdin.end();
  assert.equal((await once(child, "exit"))[0], 0);
});

test("exits after the configured reconnect attempts are exhausted", async (t) => {
  const port = await unusedPort();
  const child = spawnProxy(t, `ws://127.0.0.1:${port}`, {
    CODEX_APP_SERVER_HANDSHAKE_TIMEOUT_MS: "100",
    CODEX_APP_SERVER_RECONNECT_ATTEMPTS: "2",
    CODEX_APP_SERVER_RECONNECT_DELAY_MS: "10",
    CODEX_APP_SERVER_RECONNECT_BACKOFF_ATTEMPTS: "0",
  });
  const stderr = capture(child.stderr);

  assert.equal((await once(child, "exit"))[0], 1);
  assert.match(stderr.output(), /quick attempt 1\/2/);
  assert.match(stderr.output(), /quick attempt 2\/2/);
  assert.match(
    stderr.output(),
    /giving up after 2 quick and 0 backoff reconnect attempts/,
  );
});

test("uses an increasing delay for long-term reconnect attempts", async (t) => {
  const port = await unusedPort();
  const child = spawnProxy(t, `ws://127.0.0.1:${port}`, {
    CODEX_APP_SERVER_HANDSHAKE_TIMEOUT_MS: "100",
    CODEX_APP_SERVER_RECONNECT_ATTEMPTS: "1",
    CODEX_APP_SERVER_RECONNECT_DELAY_MS: "10",
    CODEX_APP_SERVER_RECONNECT_BACKOFF_ATTEMPTS: "3",
    CODEX_APP_SERVER_RECONNECT_BACKOFF_INITIAL_DELAY_MS: "20",
    CODEX_APP_SERVER_RECONNECT_BACKOFF_INCREMENT_MS: "10",
  });
  const stderr = capture(child.stderr);

  assert.equal((await once(child, "exit"))[0], 1);
  assert.match(stderr.output(), /reconnecting in 10 ms \(quick attempt 1\/1\)/);
  assert.match(
    stderr.output(),
    /reconnecting in 20 ms \(backoff attempt 1\/3\)/,
  );
  assert.match(
    stderr.output(),
    /reconnecting in 30 ms \(backoff attempt 2\/3\)/,
  );
  assert.match(
    stderr.output(),
    /reconnecting in 40 ms \(backoff attempt 3\/3\)/,
  );
  assert.match(
    stderr.output(),
    /giving up after 1 quick and 3 backoff reconnect attempts/,
  );
});

test("can terminate its parent after reconnect attempts are exhausted", async (t) => {
  const port = await unusedPort();
  const wrapper = spawn(
    process.execPath,
    [
      "-e",
      `
        const { spawn } = require("node:child_process");
        spawn(process.execPath, [process.argv[1], "app-server"], {
          env: process.env,
          stdio: ["pipe", "ignore", "ignore"],
        });
        setInterval(() => {}, 1_000);
      `,
      proxyPath,
    ],
    {
      env: {
        ...process.env,
        CODEX_APP_SERVER_URL: `ws://127.0.0.1:${port}`,
        CODEX_APP_SERVER_HANDSHAKE_TIMEOUT_MS: "100",
        CODEX_APP_SERVER_RECONNECT_ATTEMPTS: "0",
        CODEX_APP_SERVER_RECONNECT_DELAY_MS: "10",
        CODEX_APP_SERVER_RECONNECT_BACKOFF_ATTEMPTS: "0",
        CODEX_APP_SERVER_RECONNECT_FAILURE_ACTION: "terminate-parent",
      },
      stdio: "ignore",
    },
  );
  t.after(() => wrapper.kill());

  const [exitCode, signal] = await once(wrapper, "exit");
  assert.equal(exitCode, null);
  assert.equal(signal, "SIGTERM");
});
