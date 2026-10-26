import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { chromium } from "playwright";
import { fixtureCleanup, modelServer, rpcSocket, until } from "./support.mjs";

const execFileAsync = promisify(execFile);

function docker(args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
}

function failureLogs(name) {
  const result = spawnSync("docker", ["logs", "--tail", "120", name], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .split("\n")
    .filter((line) => /error|failed|stopped|exited|exception|fatal/i.test(line))
    .slice(-12)
    .join(" | ")
    .slice(-3500);
}

async function dismissDialogs(page) {
  for (let step = 0; step < 8; step++) {
    const overlay = page
      .locator('.codex-dialog-overlay[data-state="open"]')
      .first();
    if (!(await overlay.isVisible())) break;
    const skip = page
      .getByRole("button", {
        name: /^(Skip|Skip setup|Skip for now|Not now|Maybe later|Close)$/i,
      })
      .last();
    if (await skip.isVisible()) await skip.click();
    else await page.keyboard.press("Escape");
  }
}

test(
  "combined image serves browser chats through its own CLI and resumes saved history",
  { timeout: 240_000 },
  async (t) => {
    assert.ok(
      process.env.CODEX_TEST_NETWORK_ISOLATED === "1" ||
        process.env.CODEX_TEST_LOCAL_BRIDGE === "1",
      "Run in the CI network namespace or an explicit local Docker bridge",
    );
    const image = process.env.CODEX_TEST_ALL_IN_ONE_IMAGE_REF;
    const anchor = process.env.CODEX_TEST_NETWORK_CONTAINER;
    assert.ok(image && anchor);
    const cleanup = fixtureCleanup(t);
    const localBridge = process.env.CODEX_TEST_LOCAL_BRIDGE === "1";
    // GitHub's shared runners deny unprivileged mount namespaces. The local
    // bridge test exercises Bubblewrap; CI still tests the actual CLI tool call
    // inside its isolated network without requiring that host kernel feature.
    const sandboxMode = localBridge ? "read-only" : "danger-full-access";
    const model = localBridge
      ? { url: "http://127.0.0.1:35711/v1" }
      : await modelServer({
          host: process.env.CODEX_TEST_MODEL_HOST || "127.0.0.1",
          toolCallAt: 3,
        });
    if (!localBridge) cleanup(() => model.close());
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-all-in-one-"));
    await fs.chmod(root, 0o777);
    cleanup(async () => {
      docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "0",
        "--mount",
        `type=bind,src=${root},dst=/cleanup`,
        "--entrypoint",
        "/bin/sh",
        image,
        "-ec",
        "chmod -R 777 /cleanup",
      ]);
      await fs.rm(root, { recursive: true, force: true });
    });
    const cliHome = path.join(root, "cli");
    const webHome = path.join(root, "web");
    const workspace = path.join(root, "workspace");
    const authHome = path.join(root, "auth");
    const socketDir = path.join(root, "socket");
    // Local development uses the protected socket directly. CI instead uses a
    // loopback relay, because the runner UID differs from the container UID.
    const daemonDir = "/tmp/codex-daemon-1000";
    if (localBridge) {
      await fs.mkdir(daemonDir, { recursive: true, mode: 0o700 });
      await fs.chmod(daemonDir, 0o700);
    }
    for (const directory of [
      cliHome,
      webHome,
      workspace,
      authHome,
      ...(localBridge ? [socketDir] : []),
    ]) {
      await fs.mkdir(directory);
      await fs.chmod(directory, directory === socketDir ? 0o700 : 0o777);
    }
    await fs.writeFile(
      path.join(cliHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "ci-local-test-key" }),
    );
    await fs.writeFile(
      path.join(cliHome, "config.toml"),
      [
        'model = "ci-model"',
        'model_provider = "ci"',
        'approval_policy = "never"',
        `sandbox_mode = "${sandboxMode}"`,
        'cli_auth_credentials_store = "file"',
        "[features]",
        "plugins = false",
        "remote_plugin = false",
        "apps = false",
        "hooks = false",
        "skill_search = false",
        "skip_host_skill_discovery = true",
        "code_mode_host = false",
        "workspace_dependencies = false",
        "[model_providers.ci]",
        'name = "Local CI responses"',
        `base_url = ${JSON.stringify(model.url)}`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
      ].join("\n"),
    );
    docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "0",
      "-v",
      `${root}:/seed`,
      "--entrypoint",
      "/bin/sh",
      image,
      "-ec",
      "chown -R 1000:1000 /seed/cli /seed/web /seed/workspace /seed/auth; chmod 700 /seed/auth",
    ]);
    const name = `codex-ci-all-in-one-${process.pid}`;
    const socketMounts = localBridge
      ? ["-v", `${socketDir}:/run/codex`, "-v", `${daemonDir}:${daemonDir}`]
      : [];
    docker([
      "run",
      "-d",
      "--name",
      name,
      "--pull=never",
      "--network",
      `container:${anchor}`,
      "--security-opt",
      "seccomp=unconfined",
      "--security-opt",
      "systempaths=unconfined",
      "-v",
      `${root}:/data`,
      ...socketMounts,
      "-e",
      "CODEX_APP_SERVER_RETRY_DELAYS_MS=100",
      "-e",
      "CODEX_WEB_AUTH_ENABLED=1",
      image,
    ]);
    cleanup(() => docker(["rm", "-f", name]));
    if (localBridge) {
      docker([
        "cp",
        "test/integration/local-model-server.mjs",
        `${name}:/tmp/local-model-server.mjs`,
      ]);
      docker(["exec", "-d", name, "node", "/tmp/local-model-server.mjs"]);
    } else {
      docker([
        "cp",
        "test/integration/socket-relay.mjs",
        `${name}:/tmp/socket-relay.mjs`,
      ]);
      docker(["exec", "-d", name, "node", "/tmp/socket-relay.mjs"]);
    }
    const socketPath = path.join(socketDir, "app-server.sock");
    const base = `http://${process.env.CODEX_TEST_WEB_HOST || "127.0.0.1"}:8214/`;
    await until(
      async () => {
        if (JSON.parse(docker(["inspect", name]))[0].State.Running !== true)
          throw new Error(
            `Combined container stopped: ${docker(["logs", "--tail", "50", name])}`,
          );
        try {
          return (
            (await fetch(base, { headers: { Accept: "text/html" } })).ok &&
            (localBridge
              ? (await fs.stat(socketPath)).isSocket()
              : docker([
                  "exec",
                  name,
                  "/bin/sh",
                  "-ec",
                  "test -S /run/codex/app-server.sock",
                ]) === "")
          );
        } catch {
          return false;
        }
      },
      "combined runtime",
      60_000,
    );
    assert.equal(
      docker(["exec", name, "codex", "--version"]),
      "codex-cli 0.164.0",
    );
    assert.equal(docker(["exec", name, "id", "-u"]), "1000");
    await until(
      async () => {
        try {
          const { stdout } = await execFileAsync(
            "docker",
            [
              "exec",
              name,
              "wget",
              "-Y",
              "off",
              "-T",
              "2",
              "-q",
              "-O",
              "-",
              `${model.url}/models`,
            ],
            { encoding: "utf8", timeout: 5_000 },
          );
          return /ci-model/.test(stdout);
        } catch {
          return false;
        }
      },
      "combined CLI reaches local model fixture",
      15_000,
    );
    const connect = async () => {
      const socket = localBridge
        ? new WebSocket("ws://localhost/rpc", {
            createConnection: () => net.createConnection(socketPath),
            perMessageDeflate: false,
          })
        : new WebSocket("ws://127.0.0.1:45823/rpc", {
            perMessageDeflate: false,
          });
      await once(socket, "open");
      cleanup(() => socket.terminate());
      const rpc = rpcSocket(socket);
      await rpc.call("initialize", {
        clientInfo: { name: "all-in-one-ci", version: "1" },
        capabilities: { experimentalApi: true },
      });
      rpc.notify("initialized");
      return rpc;
    };
    const rpc = await connect();
    const modelCount = () =>
      localBridge
        ? Number(
            docker([
              "exec",
              name,
              "node",
              "-e",
              "const fs=require('fs'); console.log(fs.existsSync('/tmp/codex-model-requests.jsonl') ? fs.readFileSync('/tmp/codex-model-requests.jsonl','utf8').trim().split('\\n').length : 0)",
            ]),
          )
        : model.requests.length;
    const created = await rpc.call("thread/start", {
      cwd: "/workspace",
      model: "ci-model",
      modelProvider: "ci",
      approvalPolicy: "never",
      sandbox: sandboxMode,
    });
    const threadId = created.thread.id;
    const turn = await rpc.call("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: "Create the saved all-in-one conversation.",
          text_elements: [],
        },
      ],
    });
    try {
      await until(
        () =>
          rpc.messages.some(
            (message) =>
              message.method === "turn/completed" &&
              message.params.turn.id === turn.turn.id,
          ),
        "first combined CLI turn",
        60_000,
      );
    } catch (error) {
      throw new Error(
        `${error.message}; modelRequests=${modelCount()}; rpc=${JSON.stringify(rpc.messages.filter((message) => message.error || /turn\//.test(message.method ?? "")).map((message) => ({ method: message.method, error: message.error, status: message.params?.turn?.status })))}`,
        { cause: error },
      );
    }
    assert.equal(modelCount(), 1);
    const firstModelRequest = localBridge
      ? JSON.parse(
          docker([
            "exec",
            name,
            "node",
            "-e",
            "const fs=require('fs');console.log(fs.readFileSync('/tmp/codex-model-requests.jsonl','utf8').split('\\n')[0])",
          ]),
        )
      : model.requests[0];
    assert.ok(
      (firstModelRequest.tools ?? []).some(
        (tool) => tool.name === "exec_command",
      ),
    );

    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? {
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
            args: JSON.parse(process.env.PLAYWRIGHT_CHROMIUM_ARGS || "[]"),
          }
        : {}),
    });
    cleanup(() => browser.close());
    const page = await browser.newPage({ locale: "en-US" });
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400 && response.url().startsWith(base)) {
        browserErrors.push(
          `${response.status()} ${new URL(response.url()).pathname}`,
        );
      }
    });
    assert.equal((await fetch(`${base}__backend/status`)).status, 401);
    await page.goto(`${base}thread/${threadId}`);
    await page.getByRole("heading", { name: "Set up Codex Web" }).waitFor();
    const setupLogs = spawnSync("docker", ["logs", name], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const setupCode =
      `${setupLogs.stdout ?? ""}${setupLogs.stderr ?? ""}`.match(
        /First-run setup code: ([A-Za-z0-9_-]+)/,
      )?.[1];
    assert.ok(setupCode);
    await page.getByLabel("Setup code").fill(setupCode);
    await page.getByLabel("Username").fill("ci-admin");
    await page
      .getByLabel("Password (at least 12 characters)")
      .fill("ci-long-password-123");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(base);
    assert.ok(
      (await page.context().cookies(base)).some(
        (cookie) => cookie.name === "codex_web_session",
      ),
      "browser retained the authenticated session cookie",
    );
    assert.equal(
      await page.evaluate(
        async () => (await fetch("/__backend/status")).status,
      ),
      200,
    );
    await page.goto(`${base}thread/${threadId}`);
    try {
      await until(
        async () => {
          const visibleText = await page.locator("body").innerText();
          return (
            visibleText.includes("CI assistant response 1") ||
            visibleText.includes("What type of work do you do?")
          );
        },
        "saved chat or first-run screen",
        90_000,
      );
    } catch (error) {
      throw new Error(
        `${error.message}; state=${docker(["inspect", "--format", "{{.State.Status}}/{{.State.ExitCode}}", name])}; url=${page.url()}; visibleText=${(await page.locator("body").innerText()).slice(0, 1200)}; browserErrors=${browserErrors.slice(-16).join(" | ")}; logs=${failureLogs(name)}`,
        { cause: error },
      );
    }
    if (
      (await page.locator("body").innerText()).includes(
        "What type of work do you do?",
      )
    ) {
      for (let step = 0; step < 8; step++) {
        const skip = page
          .getByRole("button", {
            name: /^(Skip|Skip setup|Skip for now|Not now)$/i,
          })
          .last();
        if (!(await skip.isVisible())) break;
        await skip.click();
      }
    }
    await dismissDialogs(page);
    await page.evaluate(
      (id) =>
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "navigate-to-route", path: `/local/${id}` },
          }),
        ),
      threadId,
    );
    const savedResponse = page
      .getByText("CI assistant response 1", { exact: true })
      .first();
    try {
      await savedResponse.waitFor({ timeout: 10_000 });
    } catch {
      await dismissDialogs(page);
      const recent = page
        .getByText("Create the saved all-in-one conversation.", {
          exact: false,
        })
        .first();
      await recent.waitFor({ timeout: 30_000 });
      await recent.evaluate((element) => element.click());
      await dismissDialogs(page);
    }
    await savedResponse.waitFor({ timeout: 60_000 });
    await dismissDialogs(page);

    docker(["restart", name]);
    if (localBridge)
      docker(["exec", "-d", name, "node", "/tmp/local-model-server.mjs"]);
    else docker(["exec", "-d", name, "node", "/tmp/socket-relay.mjs"]);
    await until(
      async () => {
        try {
          return (
            (await fetch(base, { headers: { Accept: "text/html" } })).ok &&
            (localBridge
              ? (await fs.stat(socketPath)).isSocket()
              : docker([
                  "exec",
                  name,
                  "/bin/sh",
                  "-ec",
                  "test -S /run/codex/app-server.sock",
                ]) === "")
          );
        } catch {
          return false;
        }
      },
      "combined runtime after restart",
      60_000,
    );
    const resumed = await connect();
    const saved = await resumed.call("thread/read", {
      threadId,
      includeTurns: true,
    });
    assert.match(JSON.stringify(saved), /CI assistant response 1/);
    const resumedPage = await browser.newPage({ locale: "en-US" });
    await resumedPage.goto(`${base}thread/${threadId}`);
    await resumedPage
      .getByRole("heading", { name: "Sign in to Codex Web" })
      .waitFor();
    await resumedPage.getByLabel("Username").fill("ci-admin");
    await resumedPage.getByLabel("Password").fill("ci-long-password-123");
    await resumedPage.getByRole("button", { name: "Continue" }).click();
    await resumedPage.waitForURL(base);
    await resumedPage.goto(`${base}thread/${threadId}`);
    await dismissDialogs(resumedPage);
    await resumedPage.evaluate(
      (id) =>
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "navigate-to-route", path: `/local/${id}` },
          }),
        ),
      threadId,
    );
    const resumedResponse = resumedPage
      .getByText("CI assistant response 1", { exact: true })
      .first();
    try {
      await resumedResponse.waitFor({ timeout: 10_000 });
    } catch {
      await dismissDialogs(resumedPage);
      const recent = resumedPage
        .getByText("Create the saved all-in-one conversation.", {
          exact: false,
        })
        .first();
      await recent.waitFor({ timeout: 30_000 });
      await recent.evaluate((element) => element.click());
      await dismissDialogs(resumedPage);
    }
    await resumedResponse.waitFor({ timeout: 60_000 });
    await dismissDialogs(resumedPage);
    const composer = resumedPage
      .locator('[contenteditable="true"]:visible')
      .first();
    await composer.fill("Continue the saved conversation.");
    await resumedPage
      .getByRole("button", { name: "Send", exact: true })
      .click();
    await resumedPage
      .getByText("CI assistant response 2", { exact: true })
      .first()
      .waitFor({ timeout: 60_000 });
    assert.equal(modelCount(), 2);

    await resumed.call("turn/start", {
      threadId,
      input: [
        { type: "text", text: "Run pwd in the workspace.", text_elements: [] },
      ],
    });
    try {
      await until(
        async () => {
          const history = await resumed.call("thread/read", {
            threadId,
            includeTurns: true,
          });
          return JSON.stringify(history).includes("CI assistant response 4");
        },
        "sandboxed CLI command turn",
        35_000,
      );
    } catch (error) {
      throw new Error(
        `${error.message}; modelRequests=${modelCount()}; logs=${failureLogs(name)}`,
        { cause: error },
      );
    }
    assert.equal(
      modelCount(),
      4,
      "tool call and its result produce two model requests",
    );
    const followupRequest = localBridge
      ? JSON.parse(
          docker([
            "exec",
            name,
            "node",
            "-e",
            "const fs=require('fs');console.log(fs.readFileSync('/tmp/codex-model-requests.jsonl','utf8').trim().split('\\n')[3])",
          ]),
        )
      : model.requests[3];
    assert.match(JSON.stringify(followupRequest), /function_call_output/);
    assert.match(JSON.stringify(followupRequest), /\/workspace/);
  },
);
