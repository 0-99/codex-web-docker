import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
  server.on("connection", (socket) => {
    socket.on("message", (data) => socket.send(data.toString()));
  });
}

async function assertBridge(t, endpoint) {
  const child = spawn(
    process.execPath,
    [proxyPath, "-c", "features.code_mode_host=true", "app-server"],
    {
      env: {
        ...process.env,
        CODEX_APP_SERVER_URL: endpoint,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  t.after(() => child.kill());

  const output = readline.createInterface({ input: child.stdout });
  const response = once(output, "line");
  const request = JSON.stringify({ id: 1, method: "initialize" });
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
