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
const pendingMessages = [];
let inputEnded = false;
let opened = false;
let failed = false;

const socket = new WebSocket(connection.url, {
  ...connection.options,
  handshakeTimeout,
  maxPayload,
  perMessageDeflate: false,
});

function reportConnectionFailure(error) {
  if (failed) {
    return;
  }
  failed = true;
  process.stderr.write(
    `codex-app-server-proxy: app-server connection failed: ${error.message}\n`,
  );
}

function send(message) {
  if (socket.readyState === WebSocket.OPEN) {
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
  if (socket.readyState === WebSocket.OPEN) {
    socket.close(1000, "stdin closed");
  } else if (socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
  }
});

socket.on("open", () => {
  opened = true;
  for (const message of pendingMessages.splice(0)) {
    socket.send(message);
  }
  if (inputEnded) {
    socket.close(1000, "stdin closed");
  }
});

socket.on("message", (data, isBinary) => {
  if (isBinary) {
    reportConnectionFailure(new Error("received an unexpected binary frame"));
    socket.close(1003, "text frames required");
    return;
  }
  process.stdout.write(`${data.toString()}\n`);
});

socket.on("error", reportConnectionFailure);

socket.on("close", (code, reason) => {
  if (!failed && !inputEnded && code !== 1000) {
    reportConnectionFailure(
      new Error(
        `connection closed with code ${code}${reason.length ? ` (${reason.toString()})` : ""}`,
      ),
    );
  }
  process.exitCode = failed || (!opened && !inputEnded) ? 1 : 0;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    input.close();
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(1001, signal);
    } else {
      socket.terminate();
    }
  });
}
