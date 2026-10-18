import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

export async function until(fn, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}

export function childProcess(command, args, env = {}) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let log = "";
  child.stderr.on("data", (data) => {
    log = (log + data).slice(-20000);
  });
  child.on("error", (error) => {
    log += error.message;
  });
  return {
    child,
    log: () => log,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, "close");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function rpcStream(child) {
  const messages = [];
  const pending = new Map();
  let nextId = 0;
  const accept = (raw) => {
    const message = JSON.parse(String(raw));
    messages.push(message);
    const request = pending.get(message.id);
    if (request) {
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error)
        request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    }
  };
  readline.createInterface({ input: child.stdout }).on("line", accept);
  return {
    messages,
    notify(method, params) {
      child.stdin.write(JSON.stringify({ method, params }) + "\n");
    },
    call(method, params = {}) {
      const id = `test-${++nextId}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, 20000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    },
  };
}

async function modelServer() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (!request.url.endsWith("/responses")) {
      response.writeHead(404).end();
      return;
    }
    requests.push(JSON.parse(body));
    const text = `CI assistant response ${requests.length}`;
    const item = {
      id: `message-${requests.length}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    const result = {
      id: `response-${requests.length}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model: "ci-model",
      output: [item],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    };
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    const events = [
      [
        "response.created",
        { response: { ...result, status: "in_progress", output: [] } },
      ],
      [
        "response.output_item.added",
        {
          output_index: 0,
          item: { ...item, status: "in_progress", content: [] },
        },
      ],
      [
        "response.content_part.added",
        {
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
      ],
      [
        "response.output_text.delta",
        { item_id: item.id, output_index: 0, content_index: 0, delta: text },
      ],
      [
        "response.output_text.done",
        { item_id: item.id, output_index: 0, content_index: 0, text },
      ],
      [
        "response.content_part.done",
        {
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: item.content[0],
        },
      ],
      ["response.output_item.done", { output_index: 0, item }],
      ["response.completed", { response: result }],
    ];
    for (const [type, data] of events)
      response.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
      );
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((r) => server.close(r)),
  };
}

export async function appServerFixture(t) {
  assert.equal(
    process.env.CODEX_TEST_NETWORK_ISOLATED,
    "1",
    "Real integrations require an isolated network namespace",
  );
  assert.deepEqual(
    (await fs.readdir("/sys/class/net")).sort(),
    ["lo"],
    "Only loopback may exist in the integration network namespace",
  );
  const binary = process.env.CODEX_TEST_CLI_PATH;
  assert.ok(binary, "Set CODEX_TEST_CLI_PATH to a real Codex CLI binary");
  await fs.mkdir("scratch", { recursive: true });
  const directory = await fs.mkdtemp(path.resolve("scratch/ci-"));
  const codexHome = path.join(directory, "codex");
  const workspace = path.join(directory, "workspace");
  await fs.mkdir(codexHome);
  await fs.mkdir(workspace);
  const model = await modelServer();
  await fs.writeFile(
    path.join(codexHome, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "ci-local-test-key" }),
  );
  await fs.writeFile(
    path.join(codexHome, "config.toml"),
    [
      'model = "ci-model"',
      'model_provider = "ci"',
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      'cli_auth_credentials_store = "file"',
      "[features]",
      "plugins = false",
      "remote_plugin = false",
      "apps = false",
      "hooks = false",
      "skill_search = false",
      "skip_host_skill_discovery = true",
      "code_mode_host = false",
      "workspace_dependencies = false",
      "[model_providers.ci]",
      'name = "Local CI responses"',
      `base_url = ${JSON.stringify(model.url)}`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
    ].join("\n"),
  );
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const endpoint = `ws://127.0.0.1:${port}`;
  let serverProcess;
  async function start() {
    serverProcess = childProcess(binary, ["app-server", "--listen", endpoint], {
      CODEX_HOME: codexHome,
    });
    await until(async () => {
      if (serverProcess.child.exitCode !== null)
        throw new Error(serverProcess.log());
      try {
        const socket = new WebSocket(endpoint);
        await once(socket, "open");
        socket.close();
        return true;
      } catch {
        return false;
      }
    }, "real app-server WebSocket listener");
  }
  t.after(async () => {
    await serverProcess?.stop();
    await model.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await start();
  return {
    directory,
    workspace,
    codexHome,
    endpoint,
    model,
    log: () => serverProcess.log(),
    stop: () => serverProcess.stop(),
    start,
    async connect() {
      const socket = new WebSocket(endpoint, { perMessageDeflate: false });
      await once(socket, "open");
      return socket;
    },
  };
}
