import assert from "node:assert/strict";
import test from "node:test";
import {
  appServerFixture,
  childProcess,
  rpcStream,
  until,
} from "./support.mjs";

test(
  "real app-server persists chats and the relay restores them after a process restart",
  { timeout: 60000 },
  async (t) => {
    const server = await appServerFixture(t);
    const proxy = childProcess(
      process.execPath,
      ["docker/codex-app-server-proxy.mjs", "app-server"],
      {
        CODEX_APP_SERVER_URL: server.endpoint,
        CODEX_WEB_DISABLE_INTERNAL_APP_MCP: "1",
        CODEX_APP_SERVER_RETRY_DELAYS_MS: "100",
        CODEX_APP_SERVER_HANDSHAKE_TIMEOUT_MS: "3000",
      },
    );
    t.after(() => proxy.stop());
    const rpc = rpcStream(proxy.child);
    try {
      await rpc.call("initialize", {
        clientInfo: { name: "codex-web-ci", version: "1" },
        capabilities: { experimentalApi: true },
      });
      rpc.notify("initialized");
      const created = await rpc.call("thread/start", {
        cwd: server.workspace,
        model: "ci-model",
        modelProvider: "ci",
        approvalPolicy: "never",
        sandbox: "read-only",
      });
      const id = created.thread.id;
      const turn = await rpc.call("turn/start", {
        threadId: id,
        input: [
          {
            type: "text",
            text: "Reply with the fixed CI message.",
            text_elements: [],
          },
        ],
      });
      await until(
        () =>
          rpc.messages.find(
            (m) =>
              m.method === "turn/completed" &&
              m.params.turn.id === turn.turn.id,
          ),
        "first real turn",
      );
      let stored = await rpc.call("thread/read", {
        threadId: id,
        includeTurns: true,
      });
      assert.match(JSON.stringify(stored), /CI assistant response 1/);
      assert.equal(server.model.requests.length, 1);
      await server.stop();
      await until(
        () => /reconnecting/.test(proxy.log()),
        "relay notices stopped app-server",
      );
      let completed = false;
      const queued = rpc
        .call("thread/read", { threadId: id, includeTurns: true })
        .then((value) => {
          completed = true;
          return value;
        });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(
        completed,
        false,
        "request waits while the app-server is down",
      );
      await server.start();
      stored = await queued;
      assert.equal(stored.thread.id, id);
      assert.match(JSON.stringify(stored), /CI assistant response 1/);
      const next = await rpc.call("turn/start", {
        threadId: id,
        input: [
          {
            type: "text",
            text: "Continue this saved conversation.",
            text_elements: [],
          },
        ],
      });
      await until(
        () =>
          rpc.messages.find(
            (m) =>
              m.method === "turn/completed" &&
              m.params.turn.id === next.turn.id,
          ),
        "turn after real process restart",
      );
      stored = await rpc.call("thread/read", {
        threadId: id,
        includeTurns: true,
      });
      assert.match(JSON.stringify(stored), /CI assistant response 2/);
      assert.equal(server.model.requests.length, 2, "no turn was replayed");
    } catch (error) {
      throw new Error(
        `${error.message}\nMessages: ${JSON.stringify(rpc.messages.slice(-8))}\nProxy: ${proxy.log()}\nApp-server: ${server.log()}`,
        { cause: error },
      );
    }
  },
);
