#!/usr/bin/env node

import process from "node:process";
import readline from "node:readline";
import net from "node:net";
import { appendFileSync } from "node:fs";
import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { integerSetting, retryPolicy } from "./retry-policy.mjs";
import { createStatusReporter } from "./proxy-status.mjs";

function fail(message, exitCode = 64) {
  process.stderr.write(`codex-app-server-proxy: ${message}\n`);
  process.exit(exitCode);
}

function configuredChoice(name, fallback, choices) {
  const value = process.env[name]?.trim() || fallback;
  if (!choices.includes(value)) {
    fail(`${name} must be one of: ${choices.join(", ")}`);
  }
  return value;
}

function parseInvocation(argv) {
  const args = [...argv];
  while (args[0] === "-c") {
    if (args.length < 2) {
      fail("received -c without a value");
    }
    args.splice(0, 2);
  }

  if (args[0] !== "app-server") {
    fail("only app-server mode is supported");
  }
}

function appServerConnection() {
  const configuredUrl = process.env.CODEX_APP_SERVER_URL?.trim();
  if (!configuredUrl) {
    fail("CODEX_APP_SERVER_URL must be set");
  }

  if (configuredUrl.startsWith("unix://")) {
    const socketPath = configuredUrl.slice("unix://".length);
    if (!socketPath.startsWith("/")) {
      fail("a unix:// endpoint must contain an absolute socket path");
    }
    return {
      options: {
        createConnection: () => net.createConnection(socketPath),
      },
      url: "ws://localhost/rpc",
    };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(configuredUrl);
  } catch {
    fail("CODEX_APP_SERVER_URL is not a valid URL");
  }

  if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
    fail("CODEX_APP_SERVER_URL must use unix://, ws://, or wss://");
  }
  return { options: {}, url: configuredUrl };
}

parseInvocation(process.argv.slice(2));
const connection = appServerConnection();
let policy, maxPayload, handshakeTimeout, resumeTimeout, rpcSlowMs;
try {
  policy = retryPolicy(process.env, (message) => log(message));
  maxPayload = integerSetting(process.env, "MAX_PAYLOAD", 100 * 1024 * 1024, 1);
  handshakeTimeout = integerSetting(
    process.env,
    "HANDSHAKE_TIMEOUT_MS",
    10_000,
    1,
  );
  resumeTimeout = integerSetting(process.env, "RESUME_TIMEOUT_MS", 30_000, 1);
  rpcSlowMs = integerSetting(process.env, "CODEX_WEB_RPC_SLOW_MS", 5_000, 1);
} catch (error) {
  fail(error.message);
}
const failureAction = configuredChoice(
  "CODEX_APP_SERVER_RECONNECT_FAILURE_ACTION",
  "exit",
  ["exit", "terminate-parent"],
);
const status = createStatusReporter();
const pendingMessages = [];
const inFlight = new Map();
const requestTimes = new Map();
let traceFile = process.env.CODEX_WEB_RPC_TRACE_FILE || null;
const tracedMethods = new Set([
  "thread/start", "thread/read", "thread/resume", "thread/list", "turn/start",
  // The local relay sees no durable-host traffic. This method-only record can
  // distinguish a local file failure from the separate durable connection.
  "fs/readFile",
]);
const chatMethods = new Set([
  "thread/start", "thread/read", "thread/resume", "turn/start",
]);
let rpcErrorTimer = null;
const serverRequests = new Set();
const threads = new Map();
const resumeErrors = new Map();
const internalRequests = new Map();
const internalPrefix = `codex-web-proxy:${randomUUID()}:`;
let sequence = 0;
let initializeRequest = null;
let initializedOnce = false;
let stopping = false;
let connectionReady = false;
let retryAttempt = 0;
let reconnectTimeout = null;
let socket = null;
let startInitialize = null;

function log(message) {
  process.stderr.write(`codex-app-server-proxy: ${message}\n`);
}
function output(message) {
  process.stdout.write(
    `${typeof message === "string" ? message : JSON.stringify(message)}\n`,
  );
}
function parse(message) {
  try {
    return JSON.parse(message);
  } catch {
    return null;
  }
}
function withoutDesktopAppMcp(message) {
  if (
    process.env.CODEX_WEB_DISABLE_INTERNAL_APP_MCP !== "1" ||
    !["thread/start", "thread/resume", "thread/fork", "turn/start"].includes(
      message?.method,
    ) ||
    !message.params?.config ||
    typeof message.params.config !== "object" ||
    Array.isArray(message.params.config)
  )
    return message;

  const config = message.params.config;
  const dottedKeys = Object.keys(config).filter(
    (key) =>
      key === "mcp_servers.codex_app" ||
      key.startsWith("mcp_servers.codex_app."),
  );
  const servers = config.mcp_servers;
  const hasNestedServer =
    servers &&
    typeof servers === "object" &&
    !Array.isArray(servers) &&
    Object.hasOwn(servers, "codex_app");
  if (!dottedKeys.length && !hasNestedServer) return message;

  const filtered = { ...config };
  for (const key of dottedKeys) delete filtered[key];
  if (hasNestedServer) {
    filtered.mcp_servers = { ...servers };
    delete filtered.mcp_servers.codex_app;
  }
  log("removed Desktop-only codex_app MCP override from thread request");
  return { ...message, params: { ...message.params, config: filtered } };
}
function isRequest(message) {
  return (
    message &&
    typeof message.method === "string" &&
    Object.hasOwn(message, "id")
  );
}
function errorResponse(request, message, code = -32001) {
  traceCompletion(request, "error", code);
  if (isRequest(request)) output({ id: request.id, error: { code, message } });
}
function readyStatus() {
  status.update(resumeErrors.size ? "degraded" : "ready", {
    failedThreads: resumeErrors.size,
  });
}
function refreshChatStatus(failed = null) {
  if (!connectionReady) return;
  const waiting = [...requestTimes.values()].find((item) => item.visible);
  if (waiting) {
    clearTimeout(rpcErrorTimer);
    rpcErrorTimer = null;
    status.update("rpc-waiting", { rpcMethod: waiting.method });
    return;
  }
  if (failed && chatMethods.has(failed.method)) {
    status.update("rpc-error", {
      rpcMethod: failed.method,
      errorCode: failed.errorCode,
    });
    clearTimeout(rpcErrorTimer);
    rpcErrorTimer = setTimeout(() => {
      rpcErrorTimer = null;
      if (connectionReady && ![...requestTimes.values()].some((item) => item.visible))
        readyStatus();
    }, 10_000);
  } else if (!rpcErrorTimer) {
    readyStatus();
  }
}
function traceCompletion(request, state, errorCode = null) {
  if (!isRequest(request)) return;
  const timing = requestTimes.get(request.id);
  if (!timing) return;
  requestTimes.delete(request.id);
  clearTimeout(timing.slowTimer);
  if (timing.visible || (state === "error" && chatMethods.has(timing.method))) {
    refreshChatStatus(state === "error" ? { method: timing.method, errorCode } : null);
  }
  if (!traceFile) return;
  try {
    const code = Number.isSafeInteger(errorCode) ? errorCode : null;
    // Desktop treats every proxy stderr line as a connection error. Write
    // optional, content-free diagnostics to a dedicated file instead.
    appendFileSync(traceFile, `rpc method=${timing.method} host=local transport=stdio+websocket waitMs=${timing.waitMs} durationMs=${Date.now() - timing.startedAt} state=${state} errorCode=${code}\n`);
  } catch {
    // The trace is diagnostic only; a full or unwritable file must not break
    // the app-server connection.
    traceFile = null;
  }
}
function formatDuration(ms) {
  if (ms % 60_000 === 0)
    return `${ms / 60_000} ${ms === 60_000 ? "minute" : "minutes"}`;
  if (ms % 1000 === 0)
    return `${ms / 1000} ${ms === 1000 ? "second" : "seconds"}`;
  return `${ms} ms`;
}
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(reconnectTimeout);
  clearTimeout(rpcErrorTimer);
  for (const timing of requestTimes.values()) clearTimeout(timing.slowTimer);
  requestTimes.clear();
  for (const pending of internalRequests.values())
    pending.reject(new Error("proxy stopped"));
  internalRequests.clear();
  status.close();
  input.close();
  process.stdin.pause();
  socket?.terminate();
  process.exitCode = exitCode;
}
function scheduleReconnect(error) {
  if (stopping) return;
  log(`app-server connection failed: ${error.message}`);
  const next = policy.next(++retryAttempt);
  if (!next) {
    status.update("failed");
    log(`giving up ${policy.exhausted}`);
    for (const { parsed } of pendingMessages.splice(0))
      errorResponse(parsed, "App-server reconnect attempts exhausted.");
    if (failureAction === "terminate-parent") {
      log(`terminating parent process ${process.ppid}`);
      try {
        process.kill(process.ppid, "SIGTERM");
      } catch (error) {
        log(`failed to terminate parent process: ${error.message}`);
      }
    }
    stop(1);
    return;
  }
  status.update("retry-wait", {
    attempt: retryAttempt,
    retryAt: Date.now() + next.delay,
  });
  log(`reconnecting in ${formatDuration(next.delay)} (${next.description})`);
  reconnectTimeout = setTimeout(connect, next.delay);
}

// Never replay creation/history payloads when resuming. Only retain session
// configuration; persistent history is loaded by threadId on the app-server.
const resumeKeys = [
  "model",
  "modelProvider",
  "cwd",
  "approvalPolicy",
  "approvalsReviewer",
  "sandbox",
  "permissions",
  "config",
  "baseInstructions",
  "developerInstructions",
  "personality",
  "serviceTier",
  "runtimeWorkspaceRoots",
];
function rememberThread(request, result) {
  const thread = result?.thread;
  if (typeof thread?.id !== "string") return;
  const previous = threads.get(thread.id);
  const params = { ...previous?.params, threadId: thread.id };
  for (const key of resumeKeys) {
    if (request.params?.[key] != null) params[key] = request.params[key];
  }
  // Resolved defaults are useful when start/fork used null overrides.
  for (const key of ["model", "modelProvider", "cwd", "approvalPolicy"]) {
    if (result[key] != null) params[key] = result[key];
  }
  // permissions and legacy sandbox are mutually exclusive.
  if (request.params?.permissions != null) delete params.sandbox;
  else if (request.params?.sandbox != null) delete params.permissions;
  threads.set(thread.id, { params });
  resumeErrors.delete(thread.id);
}
function trackResponse(message) {
  const request = inFlight.get(message.id);
  if (
    !request ||
    (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error"))
  )
    return;
  inFlight.delete(message.id);
  traceCompletion(request, message.error ? "error" : "completed", message.error?.code ?? null);
  if (message.error) return;
  if (
    request.method === "turn/start" &&
    threads.has(request.params?.threadId)
  ) {
    const thread = threads.get(request.params.threadId);
    for (const key of resumeKeys) {
      if (request.params[key] != null) thread.params[key] = request.params[key];
    }
    if (request.params.permissions != null) delete thread.params.sandbox;
    else if (request.params.sandbox != null) delete thread.params.permissions;
  }
  if (["thread/start", "thread/resume", "thread/fork"].includes(request.method))
    rememberThread(request, message.result);
  if (
    ["thread/unsubscribe", "thread/archive", "thread/delete"].includes(
      request.method,
    )
  ) {
    threads.delete(request.params?.threadId);
    resumeErrors.delete(request.params?.threadId);
  }
  if (connectionReady && request.method === "thread/resume") {
    status.update(resumeErrors.size ? "degraded" : "ready", {
      failedThreads: resumeErrors.size,
    });
  }
}
function forward({ raw, parsed, queuedAt }) {
  // Server-initiated request IDs belong to this connection only. In particular,
  // do not deliver an old approval response to a restarted server.
  if (parsed && !parsed.method && Object.hasOwn(parsed, "id")) {
    if (serverRequests.delete(parsed.id)) socket.send(raw);
    return;
  }
  const threadId = parsed?.params?.threadId;
  if (
    resumeErrors.has(threadId) &&
    parsed.method !== "thread/resume" &&
    ![
      "thread/read",
      "thread/archive",
      "thread/delete",
      "thread/unsubscribe",
    ].includes(parsed.method)
  ) {
    errorResponse(
      parsed,
      `Thread could not be restored: ${resumeErrors.get(threadId)}`,
      -32002,
    );
    return;
  }
  if (isRequest(parsed)) {
    inFlight.set(parsed.id, parsed);
    if (tracedMethods.has(parsed.method)) {
      const timing = requestTimes.get(parsed.id);
      if (timing) {
        timing.waitMs = queuedAt ? Date.now() - queuedAt : 0;
        if (chatMethods.has(parsed.method)) {
          // Connection status covers queued requests. Surface long-running chat
          // work only after forwarding it, without replaying or timing it out.
          timing.slowTimer = setTimeout(() => {
            if (!connectionReady || !inFlight.has(parsed.id)) return;
            timing.visible = true;
            refreshChatStatus();
          }, rpcSlowMs);
        }
      }
    }
  }
  socket.send(raw);
}
function receiveInput(raw) {
  const original = parse(raw);
  const parsed = withoutDesktopAppMcp(original);
  if (parsed !== original) raw = JSON.stringify(parsed);
  if (isRequest(parsed) && tracedMethods.has(parsed.method)) {
    requestTimes.set(parsed.id, {
      method: parsed.method,
      startedAt: Date.now(),
      waitMs: 0,
    });
  }
  if (parsed?.method === "initialize" && isRequest(parsed)) {
    initializeRequest = { id: parsed.id, raw };
    startInitialize?.();
    return;
  }
  // The proxy owns this notification, including on every reconnect.
  if (parsed?.method === "initialized") return;
  if (
    socket?.readyState === WebSocket.OPEN &&
    (connectionReady ||
      (parsed && !parsed.method && serverRequests.has(parsed.id)))
  ) {
    forward({ raw, parsed });
  } else if (parsed && !parsed.method) {
    return; // Stale server responses cannot be queued across connections.
  } else if (pendingMessages.length < 1000) {
    pendingMessages.push({ raw, parsed, queuedAt: Date.now() });
  } else {
    errorResponse(
      parsed,
      "App-server is unavailable and its request queue is full.",
    );
  }
}
const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false,
});
input.on("line", (line) => {
  if (line) receiveInput(line);
});
input.on("close", () => stop());

function internalRequest(currentSocket, method, params) {
  const id = internalPrefix + ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // A late resume reply must not accidentally release queued requests.
      currentSocket.terminate();
      reject(new Error("app-server thread/resume response timed out"));
    }, resumeTimeout);
    internalRequests.set(id, {
      resolve(value) {
        clearTimeout(timer);
        internalRequests.delete(id);
        resolve(value);
      },
      reject(error) {
        clearTimeout(timer);
        internalRequests.delete(id);
        reject(error);
      },
    });
    currentSocket.send(JSON.stringify({ id, method, params }));
  });
}
async function restoreThreads(currentSocket) {
  resumeErrors.clear();
  let completed = 0;
  for (const [threadId, thread] of threads) {
    if (currentSocket !== socket || currentSocket.readyState !== WebSocket.OPEN)
      throw new Error("connection lost during thread restore");
    status.update("resuming", { completed, total: threads.size });
    // Even an ephemeral thread can survive a transport-only disconnect. Try
    // resume, but never create a replacement if its process state was lost.
    const response = await internalRequest(
      currentSocket,
      "thread/resume",
      thread.params,
    );
    if (response.error || response.result?.thread?.id !== threadId) {
      const reason =
        response.error?.message ||
        "thread/resume returned an unexpected thread";
      resumeErrors.set(threadId, reason);
      log(`thread restore failed: ${reason}`);
    }
    completed++;
  }
}
function connect() {
  if (stopping) return;
  reconnectTimeout = null;
  status.update("connecting", { attempt: retryAttempt });
  const currentSocket = new WebSocket(connection.url, {
    ...connection.options,
    handshakeTimeout,
    maxPayload,
    perMessageDeflate: false,
  });
  socket = currentSocket;
  connectionReady = false;
  let connectionError = null;
  let initializing = false;
  let initializeTimer;
  function initialize() {
    if (
      initializing ||
      !initializeRequest ||
      currentSocket.readyState !== WebSocket.OPEN
    )
      return;
    initializing = true;
    currentSocket.send(initializeRequest.raw);
    initializeTimer = setTimeout(() => {
      connectionError = new Error("app-server initialize response timed out");
      currentSocket.terminate();
    }, handshakeTimeout);
  }
  startInitialize = initialize;
  currentSocket.on("open", initialize);
  currentSocket.on("message", async (data, isBinary) => {
    if (isBinary) {
      connectionError = new Error("received an unexpected binary frame");
      currentSocket.terminate();
      return;
    }
    const raw = data.toString();
    const message = parse(raw);
    if (
      message &&
      !message.method &&
      internalRequests.has(message.id) &&
      (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
    ) {
      internalRequests.get(message.id).resolve(message);
      return;
    }
    if (
      initializing &&
      message?.id === initializeRequest.id &&
      (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
    ) {
      clearTimeout(initializeTimer);
      initializing = false;
      startInitialize = null;
      if (message.error) {
        connectionError = new Error(
          message.error.message || "app-server initialize failed",
        );
        currentSocket.terminate();
        return;
      }
      const wasInitialized = initializedOnce;
      const attempt = retryAttempt
        ? policy.next(retryAttempt)?.description
        : null;
      currentSocket.send(JSON.stringify({ method: "initialized" }));
      status.update("connected");
      log(
        `app-server connection ${wasInitialized ? "restored" : "established"}${attempt ? ` after ${attempt}` : ""}`,
      );
      // Only the first initialize response belongs to the stdio client.
      if (!wasInitialized) {
        initializedOnce = true;
        output(raw);
      }
      try {
        await restoreThreads(currentSocket);
        if (
          stopping ||
          currentSocket !== socket ||
          currentSocket.readyState !== WebSocket.OPEN
        )
          return;
        connectionReady = true;
        retryAttempt = 0;
        status.update(resumeErrors.size ? "degraded" : "ready", {
          failedThreads: resumeErrors.size,
        });
        for (const message of pendingMessages.splice(0)) forward(message);
      } catch (error) {
        connectionError = error;
        currentSocket.terminate();
      }
      return;
    }
    if (isRequest(message)) serverRequests.add(message.id);
    if (message) {
      trackResponse(message);
      if (
        ["thread/archived", "thread/deleted", "thread/closed"].includes(
          message.method,
        )
      ) {
        threads.delete(message.params?.threadId);
        resumeErrors.delete(message.params?.threadId);
      }
    }
    output(raw);
  });
  currentSocket.on("error", (error) => {
    connectionError = error;
  });
  currentSocket.on("close", (code) => {
    clearTimeout(initializeTimer);
    if (socket !== currentSocket) return;
    socket = null;
    connectionReady = false;
    startInitialize = null;
    serverRequests.clear();
    for (const pending of internalRequests.values())
      pending.reject(new Error("connection lost during thread restore"));
    internalRequests.clear();
    for (const request of inFlight.values())
      errorResponse(
        request,
        "App-server connection lost; request outcome is unknown. It was not retried.",
      );
    inFlight.clear();
    scheduleReconnect(
      connectionError || new Error(`connection closed with code ${code}`),
    );
  });
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop());
connect();
