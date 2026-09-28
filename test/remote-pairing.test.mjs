import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { startRemotePairing } from "../src/server/remote-pairing.js";

test("pairs through the existing Unix app-server after explicit request", async () => {
  const methods = [];
  class MockSocket extends EventEmitter {
    send(data) {
      const message = JSON.parse(data);
      methods.push(message.method);
      if (!message.id) return;
      if (message.method === "initialize") {
        assert.equal(message.params.capabilities.experimentalApi, true);
      }
      if (message.method === "remoteControl/enable") {
        assert.deepEqual(message.params, { ephemeral: true });
      }
      if (message.method === "remoteControl/pairing/start") {
        assert.deepEqual(message.params, { manualCode: true });
      }
      queueMicrotask(() =>
        this.emit(
          "message",
          JSON.stringify({
            id: message.id,
            result:
              message.method === "remoteControl/pairing/start"
                ? { manualPairingCode: "ABCD-EFGH", expiresAt: 1_800_000_000 }
                : {},
          }),
        ),
      );
    }
    close() {
      this.emit("close");
    }
  }
  const result = startRemotePairing(
    "unix:///run/codex/app-server.sock",
    (path) => {
      assert.equal(path, "/run/codex/app-server.sock");
      const socket = new MockSocket();
      queueMicrotask(() => socket.emit("open"));
      return socket;
    },
  );
  assert.deepEqual(await result, {
    code: "ABCD-EFGH",
    expiresAt: 1_800_000_000,
  });
  assert.deepEqual(methods, [
    "initialize",
    "initialized",
    "remoteControl/enable",
    "remoteControl/pairing/start",
  ]);
});
