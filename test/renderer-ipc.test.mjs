import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import electron from "../src/server/electron/index.js";
import server from "../src/server/main.js";

async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail("expected IPC event was not received");
}

async function fixture(t, createWindow) {
  const sockets = [];
  const app = await server.startIpcBridgeServer(
    { basePath: "/nested/", host: "127.0.0.1", port: 0 },
    { startMainApp: false },
  );
  globalThis.__codexElectronIpcBridge.setRendererWindowFactory(
    createWindow ?? (async () => new electron.BrowserWindow({ show: false })),
  );
  t.after(async () => {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.CLOSED) continue;
      const closed = once(socket, "close");
      socket.close();
      await closed;
    }
    await app.close();
  });
  return async () => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${app.server.address().port}/nested/__backend/ipc`,
    );
    sockets.push(socket);
    const messages = [];
    socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    await once(socket, "open");
    return {
      socket,
      messages,
      send: (value) => socket.send(JSON.stringify(value)),
      async response(requestId) {
        await until(() => messages.some((m) => m.requestId === requestId));
        const value = messages.find((m) => m.requestId === requestId);
        assert.equal(value.ok, true, value.errorMessage);
        return value.result;
      },
    };
  };
}

test(
  "tabs wait for their renderer, isolate replies and recover with a new renderer",
  { timeout: 5000 },
  async (t) => {
    const ready = Promise.withResolvers();
    const windows = [];
    const open = await fixture(t, async () => {
      await ready.promise;
      const window = new electron.BrowserWindow({ show: false });
      windows.push(window);
      return window;
    });
    electron.ipcMain.handle("test-tab", (event, marker) => {
      event.reply("private-tab-event", marker);
      return event.sender.id;
    });
    t.after(() => electron.ipcMain.removeHandler("test-tab"));
    const first = await open();
    const second = await open();
    const invoke = (client, requestId, marker) =>
      client.send({
        type: "ipc-renderer-invoke",
        channel: "test-tab",
        args: [marker],
        requestId,
      });
    invoke(first, "first", "A");
    invoke(second, "second", "B");
    await delay(20);
    assert.equal(first.messages.length + second.messages.length, 0);
    ready.resolve();
    const [firstId, secondId] = await Promise.all([
      first.response("first"),
      second.response("second"),
    ]);
    assert.notEqual(firstId, secondId);
    assert.deepEqual(
      first.messages
        .filter((m) => m.type === "ipc-main-event")
        .map((m) => m.args),
      [["A"]],
    );
    assert.deepEqual(
      second.messages
        .filter((m) => m.type === "ipc-main-event")
        .map((m) => m.args),
      [["B"]],
    );

    const closed = once(first.socket, "close");
    first.socket.close();
    await closed;
    await until(() => windows[0].isDestroyed());
    invoke(second, "still-open", "C");
    assert.equal(await second.response("still-open"), secondId);
    const replacement = await open();
    invoke(replacement, "replacement", "D");
    assert.notEqual(await replacement.response("replacement"), firstId);
  },
);

test(
  "early MessagePort data remains buffered and scoped to its browser tab",
  { timeout: 5000 },
  async (t) => {
    const open = await fixture(t);
    const received = [];
    const ports = [];
    const listener = (event, marker) =>
      ports.push({ port: event.ports[0], marker, sender: event.sender.id });
    electron.ipcMain.on("test-tab-port", listener);
    t.after(() => electron.ipcMain.off("test-tab-port", listener));
    for (const marker of ["A", "B"]) {
      const client = await open();
      client.send({
        type: "ipc-renderer-post-message",
        channel: "test-tab-port",
        message: marker,
        portIds: ["shared-id"],
      });
      client.send({
        type: "message-port-message",
        portId: "shared-id",
        data: marker,
      });
    }
    await until(() => ports.length === 2);
    await delay(20);
    for (const { port, marker, sender } of ports) {
      port.on("message", (event) =>
        received.push({ marker, sender, value: event.data }),
      );
      port.start();
    }
    assert.deepEqual(
      received.map(({ marker, value }) => [marker, value]),
      [
        ["A", "A"],
        ["B", "B"],
      ],
    );
    assert.notEqual(received[0].sender, received[1].sender);
  },
);
