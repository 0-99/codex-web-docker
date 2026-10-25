import assert from "node:assert/strict";
import test from "node:test";
import { appServerFixture, rpcSocket, until } from "./support.mjs";

test("CLI 0.155.1 completes a local turn after an MCP startup timeout", { timeout: 90_000 }, async (t) => {
  assert.equal(process.env.CODEX_TEST_NETWORK_ISOLATED, "1");
  const server = await appServerFixture(t, { slowMcp: true });
  const socket = await server.connect();
  server.cleanup(() => socket.terminate());
  const rpc = rpcSocket(socket);
  await rpc.call("initialize", {
    clientInfo: { name: "codex-web-mcp-timeout-ci", version: "1" },
    capabilities: { experimentalApi: true },
  });
  rpc.notify("initialized");
  const started = await rpc.call("thread/start", {
    cwd: server.workspace,
    model: "ci-model",
    modelProvider: "ci",
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  const turn = await rpc.call("turn/start", {
    threadId: started.thread.id,
    input: [{ type: "text", text: "Check the local MCP timeout.", text_elements: [] }],
  });
  await until(
    () => rpc.messages.some((message) =>
      message.method === "turn/completed" && message.params.turn.id === turn.turn.id),
    "turn after MCP timeout",
    60_000,
  );
  await until(() => /ci_unresponsive/.test(server.log()), "MCP timeout diagnostic", 15_000);
  assert.equal(server.model.requests.length, 1);
});
