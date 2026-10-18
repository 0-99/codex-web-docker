import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { pairingGateway, rpcSocket } from "./integration/support.mjs";

test(
  "pairing gateway forwards normal RPC over a real Unix socket and stubs only enrollment",
  { timeout: 5000, skip: process.platform !== "linux" },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cw-rpc-"));
    const socketPath = path.join(directory, "rpc.sock");
    const server = http.createServer();
    const backend = new WebSocketServer({ server });
    const sockets = new Set();
    const received = [];
    backend.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("message", (raw) => {
        const request = JSON.parse(String(raw));
        received.push(request.method);
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { method: request.method },
          }),
        );
      });
    });
    t.after(async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise((r) => backend.close(r));
      await new Promise((r) => server.close(r));
      await fs.rm(directory, { recursive: true, force: true });
    });
    server.listen(socketPath);
    await once(server, "listening");
    const gateway = await pairingGateway(t, {
      endpoint: `unix://${socketPath}`,
      openSocket: () =>
        new WebSocket("ws://localhost/rpc", {
          createConnection: () => net.createConnection(socketPath),
        }),
    });
    const client = new WebSocket("ws://localhost/rpc", {
      createConnection: () =>
        net.createConnection(gateway.endpoint.slice("unix://".length)),
    });
    t.after(() => client.terminate());
    await once(client, "open");
    const rpc = rpcSocket(client);
    assert.deepEqual(await rpc.call("initialize", {}), {
      method: "initialize",
    });
    assert.deepEqual(await rpc.call("thread/read", { threadId: "saved" }), {
      method: "thread/read",
    });
    await rpc.call("remoteControl/enable", { ephemeral: true });
    const pairing = await rpc.call("remoteControl/pairing/start", {
      manualCode: true,
    });
    assert.equal(pairing.manualPairingCode, "CI-PAIR-1234");
    assert.deepEqual(received, ["initialize", "thread/read"]);
    assert.equal(gateway.requests.length, 2);
  },
);
