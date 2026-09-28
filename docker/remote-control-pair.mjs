#!/usr/bin/env node

// Pair a phone with the same external app-server used by this web container.
// Run only from a trusted container console: the short-lived code is printed there.
import net from "node:net";
import process from "node:process";
import { once } from "node:events";
import { WebSocket } from "ws";

const endpoint = process.env.CODEX_APP_SERVER_URL || "";
if (!endpoint.startsWith("unix:///")) {
  process.stderr.write(
    "CODEX_APP_SERVER_URL must be a unix:/// socket endpoint.\n",
  );
  process.exit(1);
}

const socketPath = endpoint.slice("unix://".length);
const socket = new WebSocket("ws://localhost/rpc", {
  createConnection: () => net.createConnection(socketPath),
  perMessageDeflate: false,
  handshakeTimeout: 10_000,
});
const pending = new Map();
let nextId = 0;

socket.on("message", (data) => {
  let message;
  try {
    message = JSON.parse(data.toString());
  } catch {
    return;
  }
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timeout);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

socket.on("close", () => {
  for (const request of pending.values()) {
    clearTimeout(request.timeout);
    request.reject(new Error("App-server connection closed"));
  }
  pending.clear();
});

function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 30_000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(
      JSON.stringify({
        id,
        method,
        ...(params === undefined ? {} : { params }),
      }),
    );
  });
}

try {
  await once(socket, "open");
  await call("initialize", {
    clientInfo: { name: "codex-web-mobile-pairing", version: "1" },
    capabilities: { experimentalApi: true },
  });
  socket.send(JSON.stringify({ method: "initialized" }));

  const enabled = await call("remoteControl/enable", { ephemeral: true });
  process.stdout.write(`Remote control: ${enabled.status}\n`);

  const pairing = await call("remoteControl/pairing/start", {
    manualCode: true,
  });
  if (!pairing.manualPairingCode) {
    throw new Error("app-server did not return a manual pairing code");
  }
  process.stdout.write(`Pairing code: ${pairing.manualPairingCode}\n`);
  process.stdout.write(
    `Expires: ${new Date(pairing.expiresAt * 1000).toISOString()}\n`,
  );
} catch (error) {
  process.stderr.write(`Mobile pairing failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  socket.close();
}
