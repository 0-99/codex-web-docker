#!/usr/bin/env node

import process from "node:process";
import readline from "node:readline";
import net from "node:net";
import { WebSocket } from "ws";

function fail(message, exitCode = 64) {
  process.stderr.write(`codex-app-server-proxy: ${message}\n`);
  process.exit(exitCode);
}

function positiveInteger(name, fallback) {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(name, fallback) {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${name} must be a non-negative integer`);
  }
  return value;
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
const maxPayload = positiveInteger(
  "CODEX_APP_SERVER_MAX_PAYLOAD",
  100 * 1024 * 1024,
);
const handshakeTimeout = positiveInteger(
  "CODEX_APP_SERVER_HANDSHAKE_TIMEOUT_MS",
  10_000,
);
const maxReconnectAttempts = nonNegativeInteger(
  "CODEX_APP_SERVER_RECONNECT_ATTEMPTS",
  5,
);
const reconnectDelay = positiveInteger(
  "CODEX_APP_SERVER_RECONNECT_DELAY_MS",
  30_000,
);
const reconnectFailureAction = configuredChoice(
  "CODEX_APP_SERVER_RECONNECT_FAILURE_ACTION",
  "exit",
  ["exit", "terminate-parent"],
);
const pendingMessages = [];
let initializeRequest = null;
let initializedOnce = false;
let inputEnded = false;
let shuttingDown = false;
let finished = false;
let connectionReady = false;
let reconnectAttempts = 0;
let reconnectTimeout = null;
let socket = null;
let startInitialize = null;

function finish(exitCode) {
  if (finished) {
    return;
  }
  finished = true;
  if (reconnectTimeout !== null) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  process.exitCode = exitCode;
  input.close();
}

function scheduleReconnect(error) {
  if (inputEnded || shuttingDown || finished) {
    return;
  }

  process.stderr.write(
    `codex-app-server-proxy: app-server connection failed: ${error.message}\n`,
  );

  if (reconnectAttempts >= maxReconnectAttempts) {
    process.stderr.write(
      `codex-app-server-proxy: giving up after ${maxReconnectAttempts} reconnect attempts\n`,
    );
    if (reconnectFailureAction === "terminate-parent") {
      process.stderr.write(
        `codex-app-server-proxy: terminating parent process ${process.ppid}\n`,
      );
      try {
        process.kill(process.ppid, "SIGTERM");
      } catch (error) {
        process.stderr.write(
          `codex-app-server-proxy: failed to terminate parent process: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
    finish(1);
    return;
  }

  reconnectAttempts += 1;
  process.stderr.write(
    `codex-app-server-proxy: reconnecting in ${reconnectDelay} ms ` +
      `(attempt ${reconnectAttempts}/${maxReconnectAttempts})\n`,
  );
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    connect();
  }, reconnectDelay);
}

function send(message) {
  let parsedMessage;
  try {
    parsedMessage = JSON.parse(message);
  } catch {}

  if (
    parsedMessage?.method === "initialize" &&
    Object.hasOwn(parsedMessage, "id")
  ) {
    initializeRequest = { id: parsedMessage.id, message };
    startInitialize?.();
    return;
  }

  if (connectionReady && socket?.readyState === WebSocket.OPEN) {
    socket.send(message);
  } else {
    pendingMessages.push(message);
  }
}

const input = readline.createInterface({
  crlfDelay: Number.POSITIVE_INFINITY,
  input: process.stdin,
  terminal: false,
});

input.on("line", (line) => {
  if (line.length > 0) {
    send(line);
  }
});

input.on("close", () => {
  inputEnded = true;
  if (reconnectTimeout !== null) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  if (socket?.readyState === WebSocket.OPEN) {
    socket.close(1000, "stdin closed");
  } else if (socket?.readyState === WebSocket.CONNECTING) {
    socket.terminate();
  }
});

function connect() {
  if (inputEnded || shuttingDown || finished) {
    return;
  }

  const currentSocket = new WebSocket(connection.url, {
    ...connection.options,
    handshakeTimeout,
    maxPayload,
    perMessageDeflate: false,
  });
  socket = currentSocket;
  connectionReady = false;
  let connectionError = null;
  let awaitingInitializeResponse = false;
  let initializeResponseTimeout = null;

  function clearInitializeResponseTimeout() {
    if (initializeResponseTimeout !== null) {
      clearTimeout(initializeResponseTimeout);
      initializeResponseTimeout = null;
    }
  }

  function flushPendingMessages() {
    for (const message of pendingMessages.splice(0)) {
      currentSocket.send(message);
    }
  }

  function initializeConnection() {
    if (
      currentSocket.readyState !== WebSocket.OPEN ||
      awaitingInitializeResponse ||
      initializeRequest === null
    ) {
      return;
    }

    connectionReady = false;
    awaitingInitializeResponse = true;
    currentSocket.send(initializeRequest.message);
    initializeResponseTimeout = setTimeout(() => {
      connectionError = new Error("app-server initialize response timed out");
      currentSocket.terminate();
    }, handshakeTimeout);
  }

  startInitialize = initializeConnection;

  currentSocket.on("open", () => {
    initializeConnection();
    if (inputEnded) {
      currentSocket.close(1000, "stdin closed");
    }
  });

  currentSocket.on("message", (data, isBinary) => {
    if (isBinary) {
      connectionError = new Error("received an unexpected binary frame");
      currentSocket.close(1003, "text frames required");
      return;
    }

    const message = data.toString();
    if (awaitingInitializeResponse && initializeRequest !== null) {
      let parsedMessage;
      try {
        parsedMessage = JSON.parse(message);
      } catch {}

      if (
        parsedMessage?.id === initializeRequest.id &&
        (Object.hasOwn(parsedMessage, "result") ||
          Object.hasOwn(parsedMessage, "error"))
      ) {
        clearInitializeResponseTimeout();
        awaitingInitializeResponse = false;
        if (parsedMessage.error) {
          connectionError = new Error(
            parsedMessage.error.message ?? "app-server initialize failed",
          );
          currentSocket.close(1011, "app-server initialize failed");
          return;
        }

        const wasAlreadyInitialized = initializedOnce;
        initializedOnce = true;
        connectionReady = true;
        reconnectAttempts = 0;
        if (!wasAlreadyInitialized) {
          process.stdout.write(`${message}\n`);
        }
        flushPendingMessages();
        return;
      }
    }

    process.stdout.write(`${message}\n`);
  });

  currentSocket.on("error", (error) => {
    connectionError = error;
  });

  currentSocket.on("close", (code, reason) => {
    clearInitializeResponseTimeout();
    if (socket === currentSocket) {
      socket = null;
      connectionReady = false;
      startInitialize = null;
    }
    if (inputEnded || shuttingDown || finished) {
      return;
    }

    scheduleReconnect(
      connectionError ??
        new Error(
          `connection closed with code ${code}${reason.length ? ` (${reason.toString()})` : ""}`,
        ),
    );
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shuttingDown = true;
    input.close();
    if (socket?.readyState === WebSocket.OPEN) {
      socket.close(1001, signal);
    } else if (socket?.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
  });
}

connect();
