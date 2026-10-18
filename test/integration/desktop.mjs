import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { chromium } from "playwright";
import {
  appServerFixture,
  childProcess,
  until,
  pairingGateway,
  rpcSocket,
} from "./support.mjs";

test(
  "real Desktop resumes saved chats, sends turns, survives reconnect and offers mobile pairing",
  { timeout: 120000 },
  async (t) => {
    const appServer = await appServerFixture(t);
    const gateway = await pairingGateway(t, appServer);
    const seedSocket = await appServer.connect();
    t.after(() => seedSocket.terminate());
    const seed = rpcSocket(seedSocket);
    await seed.call("initialize", {
      clientInfo: { name: "codex-web-ci-seed", version: "1" },
      capabilities: { experimentalApi: true },
    });
    seed.notify("initialized");
    const created = await seed.call("thread/start", {
      cwd: appServer.workspace,
      model: "ci-model",
      modelProvider: "ci",
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const threadId = created.thread.id;
    const turn = await seed.call("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: "Create the saved CI conversation.",
          text_elements: [],
        },
      ],
    });
    await until(
      () =>
        seed.messages.some(
          (m) =>
            m.method === "turn/completed" && m.params.turn.id === turn.turn.id,
        ),
      "seeded saved conversation",
    );
    seedSocket.close();
    const reservation = net.createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((r) => reservation.close(r));
    const proxy = path.join(appServer.directory, "relay.mjs");
    await fs.writeFile(
      proxy,
      `#!/usr/bin/env node\nimport ${JSON.stringify(new URL("../../docker/codex-app-server-proxy.mjs", import.meta.url).href)};\n`,
      { mode: 0o755 },
    );
    const backend = childProcess(
      process.execPath,
      ["src/server/main.js", "--host", "127.0.0.1", "--port", String(port)],
      {
        CODEX_APP_SERVER_URL: gateway.endpoint,
        CODEX_CLI_PATH: proxy,
        CODEX_WEB_USER_DATA_DIR: path.join(appServer.directory, "web"),
        CODEX_WEB_BASE_PATH: "/ci/nested/",
        CODEX_WEB_DISABLE_INTERNAL_APP_MCP: "1",
        CODEX_APP_SERVER_RETRY_DELAYS_MS: "100",
      },
    );
    t.after(() => backend.stop());
    const base = `http://127.0.0.1:${port}/ci/nested/`;
    await until(async () => {
      if (backend.child.exitCode !== null) throw new Error(backend.log());
      try {
        return (await fetch(base)).ok;
      } catch {
        return false;
      }
    }, "Desktop HTTP endpoint");
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? {
            executablePath: path.resolve(
              process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
            ),
            args: JSON.parse(process.env.PLAYWRIGHT_CHROMIUM_ARGS || "[]"),
          }
        : {}),
    });
    t.after(() => browser.close());
    const context = await browser.newContext({
      viewport: { width: 393, height: 740 },
      isMobile: true,
      locale: "en-US",
    });
    await context.route("**/*", (route) =>
      new URL(route.request().url()).hostname === "127.0.0.1"
        ? route.continue()
        : route.abort(),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto(base + "thread/" + threadId);
      await page
        .getByText("CI assistant response 1", { exact: true })
        .first()
        .waitFor({ timeout: 45000 });
      const composer = page.locator('[contenteditable="true"]').first();
      await composer.waitFor({ timeout: 45000 });
      await composer.fill(
        "Continue the saved conversation in the real browser.",
      );
      await composer.press("Enter");
      await page
        .getByText("CI assistant response 2", { exact: true })
        .first()
        .waitFor({ timeout: 30000 });
      assert.equal(appServer.model.requests.length, 2);
      await composer.fill("Draft retained across mobile resizing");
      await appServer.stop();
      await page.locator("#codex-web-status").waitFor({ state: "visible" });
      await appServer.start();
      await page
        .locator("#codex-web-status")
        .waitFor({ state: "hidden", timeout: 30000 });
      assert.equal(
        await composer.innerText(),
        "Draft retained across mobile resizing",
      );
      for (const viewport of [
        { width: 393, height: 380 },
        { width: 800, height: 393 },
        { width: 393, height: 740 },
      ]) {
        await page.setViewportSize(viewport);
        await until(async () => {
          const b = await composer.boundingBox();
          return b && b.y >= 0 && b.y + b.height <= viewport.height + 1;
        }, "real mobile composer remains visible");
        assert.equal(
          await composer.innerText(),
          "Draft retained across mobile resizing",
        );
      }
      await page.reload();
      await page
        .getByText("CI assistant response 2", { exact: true })
        .first()
        .waitFor();
      await page.evaluate(() =>
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "navigate-to-route", path: "/settings/connections" },
          }),
        ),
      );
      await page
        .getByRole("tab", { name: "Control this PC", exact: true })
        .click();
      const pairing = page.getByRole("button", {
        name: "Generate pairing code",
        exact: true,
      });
      await pairing.waitFor();
      await pairing.click();
      await page.getByText("CI-PAIR-1234", { exact: true }).waitFor();
      assert.deepEqual(
        gateway.requests.map((r) => r.method),
        ["remoteControl/enable", "remoteControl/pairing/start"],
      );
      assert.deepEqual(gateway.requests[0].params, { ephemeral: true });
      assert.deepEqual(gateway.requests[1].params, { manualCode: true });
      assert.equal(
        appServer.model.requests.length,
        2,
        "no extra turns after restart or reload",
      );
      assert.deepEqual(errors, []);
    } catch (e) {
      await fs.mkdir("scratch/integration-results", { recursive: true });
      await page.screenshot({
        path: "scratch/integration-results/desktop-failure.png",
      });
      await fs.writeFile(
        "scratch/integration-results/desktop-failure.html",
        await page.content(),
      );
      throw new Error(
        `${e.message}\nPage: ${(await page.locator("body").innerText()).slice(-5000)}\nErrors: ${errors.join("\n")}\nBackend: ${backend.log()}\nApp-server: ${appServer.log()}`,
        { cause: e },
      );
    }
  },
);
