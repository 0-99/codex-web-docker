import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";

export async function until(fn, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}

/**
 * Register cleanup after acquiring each resource, sharing this stack with all
 * dependent fixtures. Reverse acquisition order stops clients before servers
 * and file writers before deleting their shared home.
 *
 * Separate Node test after-hooks run in registration order: deleting the home
 * first caused ENOTEMPTY races and left processes alive until the CI timeout.
 * Collect errors so a failed disposer cannot prevent the remaining shutdown.
 */
export function fixtureCleanup(t) {
  const disposers = [];
  t.after(async () => {
    const errors = [];
    for (const dispose of disposers.reverse()) {
      try {
        await dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        `Integration fixture cleanup failed: ${errors.map((error) => error.message).join("; ")}`,
      );
  });
  return (dispose) => disposers.push(dispose);
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

export function rpcSocket(socket) {
  const stdout = new PassThrough();
  socket.on("message", (data) => stdout.write(String(data) + "\n"));
  return rpcStream({ stdout, stdin: { write: (data) => socket.send(data) } });
}

// Remote-control enrollment belongs to the authenticated cloud service. Stub
// only those two requests; all normal Desktop RPC reaches the real CLI.
export async function pairingGateway(t, appServer, { delayMethods = {} } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cw-pair-"));
  const socketPath = path.join(directory, "rpc.sock");
  const server = http.createServer((_, reply) => reply.writeHead(404).end());
  const ws = new WebSocketServer({ server });
  const connections = new Set();
  const requests = [];
  // Keep both directions for startup failure diagnostics. Traffic comes from
  // the isolated fixture with dummy credentials and a local model server.
  const traffic = [];
  ws.on("connection", (client) => {
    const remote = appServer.openSocket();
    connections.add(client);
    connections.add(remote);
    const queued = [];
    remote.on("open", () => {
      for (const data of queued.splice(0)) remote.send(data);
    });
    client.on("message", (raw) => {
      const data = String(raw);
      const message = JSON.parse(data);
      traffic.push({ at: Date.now(), direction: "request", message });
      if (
        message.method === "remoteControl/enable" ||
        message.method === "remoteControl/pairing/start"
      ) {
        requests.push(message);
        const result =
          message.method === "remoteControl/enable"
            ? {}
            : {
                manualPairingCode: "CI-PAIR-1234",
                expiresAt: Math.floor(Date.now() / 1000) + 300,
              };
        client.send(JSON.stringify({ id: message.id, result }));
      } else {
        // Delay forwarding selected requests to the real CLI. This exercises
        // the browser's pending state without fabricating RPC responses.
        const forward = () => {
          if (remote.readyState === WebSocket.OPEN) remote.send(data);
          else queued.push(data);
        };
        const wait = delayMethods[message.method] ?? 0;
        if (wait > 0) setTimeout(forward, wait);
        else forward();
      }
    });
    remote.on("message", (data) => {
      traffic.push({
        at: Date.now(),
        direction: "response",
        message: JSON.parse(String(data)),
      });
      if (client.readyState === WebSocket.OPEN) client.send(String(data));
    });
    client.on("close", () => remote.terminate());
    remote.on("close", () => client.close());
    remote.on("error", () => client.close());
  });
  // Join the upstream fixture's stack so this gateway stops before its server.
  // Standalone gateway tests can instead supply a mock without a cleanup stack.
  const cleanup = appServer.cleanup ?? fixtureCleanup(t);
  cleanup(async () => {
    for (const socket of connections) socket.terminate();
    await new Promise((r) => ws.close(r));
    await new Promise((r) => server.close(r));
    await fs.rm(directory, { recursive: true, force: true });
  });
  server.listen(socketPath);
  await once(server, "listening");
  return {
    endpoint: `unix://${socketPath}`,
    directory,
    socketPath,
    requests,
    traffic,
  };
}

export async function modelServer({
  host = "127.0.0.1",
  toolCallAt = null,
} = {}) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.url.endsWith("/models")) {
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          object: "list",
          data: [{ id: "ci-model", object: "model", owned_by: "ci" }],
        }),
      );
      return;
    }
    if (!request.url.endsWith("/responses")) {
      response.writeHead(404).end();
      return;
    }
    requests.push(JSON.parse(body));
    const text = `CI assistant response ${requests.length}`;
    const toolCall = requests.length === toolCallAt;
    const item = toolCall
      ? {
          id: `call-${requests.length}`,
          type: "function_call",
          call_id: `call-${requests.length}`,
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "pwd", workdir: "/workspace" }),
          status: "completed",
        }
      : {
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
          item: toolCall
            ? { ...item, status: "in_progress", arguments: "" }
            : { ...item, status: "in_progress", content: [] },
        },
      ],
      ...(toolCall
        ? [
            [
              "response.function_call_arguments.delta",
              { item_id: item.id, output_index: 0, delta: item.arguments },
            ],
            [
              "response.function_call_arguments.done",
              { item_id: item.id, output_index: 0, arguments: item.arguments },
            ],
          ]
        : [
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
              {
                item_id: item.id,
                output_index: 0,
                content_index: 0,
                delta: text,
              },
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
          ]),
      ["response.output_item.done", { output_index: 0, item }],
      ["response.completed", { response: result }],
    ];
    for (const [type, data] of events)
      response.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
      );
    response.end();
  });
  server.listen(0, host);
  await once(server, "listening");
  return {
    requests,
    url: `http://${host}:${server.address().port}/v1`,
    close: () => new Promise((r) => server.close(r)),
  };
}

export async function appServerFixture(
  t,
  { chatgptAuth, slowMcp = false } = {},
) {
  assert.equal(
    process.env.CODEX_TEST_NETWORK_ISOLATED,
    "1",
    "Real integrations require an isolated network namespace",
  );
  assert.deepEqual(
    Object.keys(os.networkInterfaces()).sort(),
    ["lo"],
    "Only loopback may exist in the integration network namespace",
  );
  const binary = process.env.CODEX_TEST_CLI_PATH;
  assert.ok(binary, "Set CODEX_TEST_CLI_PATH to a real Codex CLI binary");
  await fs.mkdir("scratch", { recursive: true });
  const directory = await fs.mkdtemp(path.resolve("scratch/ci-"));
  const cleanup = fixtureCleanup(t);
  // Register the directory first so it is removed last. Callers must add their
  // backend/browser resources to this same stack to stop writers before removal.
  cleanup(() => fs.rm(directory, { recursive: true, force: true }));
  const codexHome = path.join(directory, "codex");
  const workspace = path.join(directory, "workspace");
  await fs.mkdir(codexHome);
  await fs.mkdir(workspace);
  const schemaDirectory = path.join(directory, "schema");
  execFileSync(
    binary,
    [
      "app-server",
      "generate-json-schema",
      "--experimental",
      "--out",
      schemaDirectory,
    ],
    {
      env: { ...process.env, CODEX_HOME: codexHome },
      timeout: 10000,
    },
  );
  const schema = JSON.parse(
    await fs.readFile(path.join(schemaDirectory, "ClientRequest.json"), "utf8"),
  );
  for (const method of ["remoteControl/enable", "remoteControl/pairing/start"])
    assert.ok(
      JSON.stringify(schema).includes(`"${method}"`),
      `CLI supports ${method}`,
    );
  assert.ok(schema.definitions.RemoteControlEnableParams.properties.ephemeral);
  assert.ok(
    schema.definitions.RemoteControlPairingStartParams.properties.manualCode,
  );
  const model = await modelServer();
  cleanup(() => model.close());
  await fs.writeFile(
    path.join(codexHome, "auth.json"),
    // Routing tests need the real CLI's ChatGPT response shape. The isolation
    // guard keeps these synthetic credentials away from real services and homes.
    JSON.stringify(chatgptAuth ?? { OPENAI_API_KEY: "ci-local-test-key" }),
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
      `requires_openai_auth = ${Boolean(chatgptAuth)}`,
      ...(slowMcp
        ? [
            "[mcp_servers.ci_unresponsive]",
            'command = "/bin/sh"',
            'args = ["-c", "sleep 60"]',
            "startup_timeout_sec = 2",
          ]
        : []),
    ].join("\n"),
  );
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const socketPath = path.join(directory, "rpc.sock");
  const inContainer = Boolean(process.env.CODEX_TEST_IMAGE_REF);
  // Exercise the shared Unix-socket transport used by the Compose service.
  // Recent CLIs require authentication for non-loopback WebSocket listeners.
  const endpoint = inContainer
    ? `unix://${socketPath}`
    : `ws://127.0.0.1:${port}`;
  function openSocket() {
    return new WebSocket(inContainer ? "ws://localhost/rpc" : endpoint, {
      perMessageDeflate: false,
      ...(inContainer
        ? { createConnection: () => net.createConnection(socketPath) }
        : {}),
    });
  }
  let serverProcess;
  async function start() {
    serverProcess = childProcess(binary, ["app-server", "--listen", endpoint], {
      CODEX_HOME: codexHome,
    });
    let lastSocketError;
    try {
      await until(async () => {
        if (serverProcess.child.exitCode !== null)
          throw new Error(serverProcess.log());
        const socket = openSocket();
        try {
          await once(socket, "open");
          socket.close();
          return true;
        } catch (error) {
          lastSocketError = error;
          socket.terminate();
          return false;
        }
      }, "real app-server listener");
    } catch (error) {
      // A live process can still reject the WebSocket handshake. Record only
      // transport diagnostics, never the CLI's potentially sensitive stderr.
      const socketExists = inContainer
        ? await fs.access(socketPath).then(
            () => true,
            () => false,
          )
        : undefined;
      const socketTarget = inContainer
        ? await fs.readlink(socketPath).catch(() => undefined)
        : undefined;
      throw new Error(
        `${error.message}; socketExists=${socketExists}; socketTarget=${socketTarget ?? "none"}; lastSocketError=${lastSocketError?.message ?? "none"}; exitCode=${serverProcess.child.exitCode}`,
        { cause: error },
      );
    }
  }
  // Resolve the current process at shutdown: reconnect tests replace it through
  // stop()/start(), so capturing the initial process would leak its replacement.
  cleanup(() => serverProcess?.stop());
  await start();
  return {
    cleanup,
    directory,
    workspace,
    codexHome,
    endpoint,
    model,
    log: () => serverProcess.log(),
    stop: () => serverProcess.stop(),
    start,
    openSocket,
    async connect() {
      const socket = openSocket();
      await once(socket, "open");
      return socket;
    },
  };
}
