import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { appServerFixture, pairingGateway, rpcSocket, until } from "./support.mjs";

function docker(args) {
  return execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 });
}

function containerState(name) {
  return JSON.parse(docker(["inspect", name]))[0].State;
}

function safeWebDiagnostics(name) {
  const result = spawnSync("docker", ["logs", "--tail", "200", name], { encoding: "utf8", timeout: 30_000 });
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .split("\n")
    .filter((line) => /rpc method=|spawn (gh|git) ENOENT|\[optional-tool\]|IPC bridge listening/.test(line))
    .slice(-20);
}

function safeRpcTrace(name) {
  const result = spawnSync("docker", ["exec", name, "tail", "-n", "40", "/home/node/.codex/rpc-trace.log"], { encoding: "utf8", timeout: 30_000 });
  return result.status === 0 ? result.stdout.trim().split("\n") : [];
}

function rpcCount(gateway, method) {
  return gateway.traffic.filter(
    ({ direction, message }) => direction === "request" && message.method === method,
  ).length;
}

function listedThreadIds(listing) {
  const rows = listing.data ?? listing.threads;
  assert.ok(Array.isArray(rows), `Unexpected thread/list shape: ${Object.keys(listing).join(",")}`);
  return new Set(rows.map((thread) => thread.id));
}

test("built Web runtime opens a saved chat and creates exactly one new chat", { timeout: 240_000 }, async (t) => {
  assert.equal(process.env.CODEX_TEST_NETWORK_ISOLATED, "1");
  const image = process.env.CODEX_TEST_WEB_IMAGE_REF;
  const anchor = process.env.CODEX_TEST_NETWORK_CONTAINER;
  assert.ok(image && anchor, "Set the built Web image and isolated network anchor");
  // A real CLI MCP handshake that exceeds its startup deadline must not leave
  // either chat permanently pending after the thread RPC completes.
  const server = await appServerFixture(t, { slowMcp: true });
  const gateway = await pairingGateway(t, server, {
    // Match the observed slow start window while retaining real CLI replies.
    delayMethods: { "thread/start": 25_000, "thread/read": 500 },
  });
  const seedSocket = await server.connect();
  server.cleanup(() => seedSocket.terminate());
  const seed = rpcSocket(seedSocket);
  await seed.call("initialize", {
    clientInfo: { name: "codex-web-runtime-ci", version: "1" },
    capabilities: { experimentalApi: true },
  });
  seed.notify("initialized");
  const started = await seed.call("thread/start", {
    cwd: server.workspace,
    model: "ci-model",
    modelProvider: "ci",
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  const threadId = started.thread.id;
  const firstTurn = await seed.call("turn/start", {
    threadId,
    input: [{ type: "text", text: "Create the saved CI conversation.", text_elements: [] }],
  });
  await until(
    () => seed.messages.some((message) => message.method === "turn/completed" && message.params.turn.id === firstTurn.turn.id),
    "seeded turn completion",
    60_000,
  );
  await until(() => /ci_unresponsive/.test(server.log()), "MCP timeout diagnostic", 15_000);
  const initialThreads = listedThreadIds(await seed.call("thread/list", {}));

  // The Web image has its own synthetic home. It sees the shared workspace and
  // the local RPC gateway socket, never the CLI's home or authentication file.
  const webHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-web-runtime-"));
  server.cleanup(async () => {
    // The image's UID 1000 can create private subdirectories that the runner
    // UID cannot traverse. Restore permissions inside an isolated root helper.
    docker([
      "run", "--rm", "--pull=never", "--network", "none", "--user", "0",
      "--mount", `type=bind,src=${webHome},dst=/cleanup`,
      "--mount", `type=bind,src=${server.workspace},dst=/workspace-cleanup`,
      "--entrypoint", "/bin/sh", image, "-ec", "chmod -R 777 /cleanup /workspace-cleanup",
    ]);
    await fs.rm(webHome, { recursive: true, force: true });
  });
  await fs.chmod(webHome, 0o777);
  await fs.writeFile(
    path.join(webHome, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "ci-local-test-key" }),
  );
  await fs.chmod(server.workspace, 0o777);
  await fs.chmod(gateway.directory, 0o711);
  await fs.chmod(gateway.socketPath, 0o777);
  const name = `codex-ci-web-${process.pid}`;
  docker([
    "run", "--detach", "--name", name, "--pull=never",
    "--network", `container:${anchor}`,
    "--mount", `type=bind,src=${webHome},dst=/home/node/.codex`,
    "--mount", `type=bind,src=${server.workspace},dst=${server.workspace}`,
    "--mount", `type=bind,src=${server.workspace},dst=/home/node/Documents/Codex`,
    "--mount", `type=bind,src=${gateway.directory},dst=${gateway.directory}`,
    "--env", `CODEX_APP_SERVER_URL=${gateway.endpoint}`,
    "--env", "CODEX_HOME=/home/node/.codex",
    "--env", "CODEX_WEB_USER_DATA_DIR=/home/node/.codex",
    "--env", "CODEX_WEB_BASE_PATH=/ci/nested/",
    "--env", "CODEX_WEB_DISABLE_INTERNAL_APP_MCP=1",
    "--env", "CODEX_WEB_RPC_TRACE_FILE=/home/node/.codex/rpc-trace.log",
    "--env", "CODEX_WEB_RPC_SLOW_MS=2000",
    "--env", "CODEX_APP_SERVER_RETRY_DELAYS_MS=100",
    image,
  ]);
  server.cleanup(() => docker(["rm", "--force", name]));
  const initialPid = containerState(name).Pid;
  assert.ok(initialPid > 0);
  const base = "http://127.0.0.1:8214/ci/nested/";
  await until(async () => {
    const state = containerState(name);
    assert.equal(state.Running, true, `Web container exited with ${state.ExitCode}; ${safeWebDiagnostics(name).join(" | ")}`);
    try {
      return (await fetch(base)).ok;
    } catch {
      return false;
    }
  }, "built Web runtime endpoint", 45_000);

  const browser = await chromium.launch({ headless: true });
  server.cleanup(() => browser.close());
  const page = await browser.newPage({ locale: "en-US" });
  page.setDefaultTimeout(45_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.name));
  let startsBeforeNewClick = null;
  let startsAfterNewClick = null;
  let persistedAfterCount = null;
  try {
    await page.goto(`${base}thread/${threadId}`);
    await until(async () =>
      (await page.getByText("CI assistant response 1", { exact: true }).first().isVisible()) ||
      (await page.getByText("What type of work do you do?", { exact: true }).isVisible()),
    "saved chat or first-run screen", 60_000);
    if (await page.getByText("What type of work do you do?", { exact: true }).isVisible()) {
      for (let step = 0; step < 8; step++) {
        const skip = page.getByRole("button", { name: /^(Skip|Skip setup|Skip for now|Not now)$/i }).last();
        if (!(await skip.isVisible())) break;
        await skip.click();
      }
    }
    // First-run onboarding can replace the deep link with its own memory route.
    // Ask the real Desktop router to restore the seeded local thread afterward.
    await page.evaluate((id) => window.dispatchEvent(new MessageEvent("message", {
      data: { type: "navigate-to-route", path: `/local/${id}` },
    })), threadId);
    await page.getByText("CI assistant response 1", { exact: true }).first().waitFor();

    // Navigate away, then select the saved chat through a real sidebar element.
    await page.goto(base);
    const threadLink = page.locator(`[href*="${threadId}"], [data-thread-id="${threadId}"]`).first();
    const threadTitle = page.getByText("Create the saved CI conversation.", { exact: false }).first();
    await until(async () => (await threadLink.isVisible()) || (await threadTitle.isVisible()), "saved chat in sidebar", 45_000);
    if (await threadLink.isVisible()) await threadLink.click();
    else await threadTitle.click();
    await page.getByText("CI assistant response 1", { exact: true }).first().waitFor();
    const composer = page.locator('[contenteditable="true"]:visible').first();
    await composer.fill("Continue the saved CI conversation.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText("CI assistant response 2", { exact: true }).first().waitFor();

    startsBeforeNewClick = rpcCount(gateway, "thread/start");
    const newChat = page.getByRole("button", { name: /new (chat|thread|conversation)/i }).first();
    await newChat.click();
    startsAfterNewClick = rpcCount(gateway, "thread/start");
    await composer.fill("Start one new CI conversation.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.locator("#codex-web-status").getByText("Creating chat …", { exact: true }).waitFor();
    await page.getByText("CI assistant response 3", { exact: true }).first().waitFor();
    let finalThreads;
    await until(async () => {
      finalThreads = listedThreadIds(await seed.call("thread/list", {}));
      persistedAfterCount = finalThreads.size;
      return [...finalThreads].some((id) => !initialThreads.has(id));
    }, "new persistent thread", 15_000);
    assert.equal([...finalThreads].filter((id) => !initialThreads.has(id)).length, 1,
      "one new persistent thread appears in the CLI's thread list");
    const newThreadId = [...finalThreads].find((id) => !initialThreads.has(id));
    const localRequests = gateway.traffic
      .filter(({ direction }) => direction === "request")
      .map(({ message }) => message);
    assert.ok(localRequests.some(({ method, params }) =>
      ["thread/read", "thread/resume"].includes(method) && params?.threadId === threadId),
    "the saved local thread is loaded through its local app-server");
    assert.ok(localRequests.some(({ method, params }) =>
      method === "turn/start" && params?.threadId === threadId),
    "the saved local thread sends its turn to the same app-server");
    assert.ok(localRequests.some(({ method, params }) =>
      method === "turn/start" && params?.threadId === newThreadId),
    "the new local thread sends its turn to the same app-server");
    assert.equal(server.model.requests.length, 3);
    assert.equal(containerState(name).Pid, initialPid, "the same Web backend process survives both chats");
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({
      persistentThreadsAdded: [...finalThreads].filter((id) => !initialThreads.has(id)).length,
      threadStartEphemeral: gateway.traffic
        .filter(({ direction, message }) => direction === "request" && message.method === "thread/start")
        .map(({ message }) => message.params?.ephemeral ?? null),
      backendPidUnchanged: true,
    }));
  } catch (error) {
    const methods = gateway.traffic
      .filter(({ direction }) => direction === "request")
      .map(({ message }) => message.method);
    const starts = gateway.traffic
      .filter(({ direction, message }) => direction === "request" && message.method === "thread/start")
      .map(({ at, message }) => ({
        at,
        keys: Object.keys(message.params ?? {}).sort(),
        ephemeral: message.params?.ephemeral,
        historyMode: message.params?.historyMode,
        threadSourceType: typeof message.params?.threadSource,
        parametersHash: createHash("sha256").update(JSON.stringify(message.params ?? {})).digest("hex").slice(0, 12),
      }));
    throw new Error(
      `${error.message}\nWeb state: ${JSON.stringify(containerState(name))}\nRPC methods: ${JSON.stringify(methods)}\nThread starts: ${JSON.stringify(starts)}\nStarts before/after New click: ${startsBeforeNewClick}/${startsAfterNewClick}\nPersisted thread counts before/after: ${initialThreads.size}/${persistedAfterCount}\nRPC trace: ${JSON.stringify(safeRpcTrace(name))}\nWeb diagnostics: ${JSON.stringify(safeWebDiagnostics(name))}\nBrowser error types: ${JSON.stringify(pageErrors)}`,
      { cause: error },
    );
  }
});
