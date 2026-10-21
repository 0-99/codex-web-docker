import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { chromium } from "playwright";
import { format } from "prettier";
import {
  appServerFixture,
  childProcess,
  until,
  pairingGateway,
  rpcSocket,
} from "./support.mjs";

for (let startupRun = 1; startupRun <= 5; startupRun++)
  test(
    `real Desktop resumes saved chats, sends turns, survives reconnect and offers mobile pairing (cold start ${startupRun})`,
    { timeout: 180000 },
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
              m.method === "turn/completed" &&
              m.params.turn.id === turn.turn.id,
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
          CODEX_HOME: appServer.codexHome,
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
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname !== "127.0.0.1") return route.abort();
        // Expose the actual startup decision inputs without overriding any gate.
        // A blank splash must explain what it is waiting for in CI diagnostics.
        if (/\/app-initial-[^/]+\.js$/.test(url.pathname)) {
          const response = await route.fetch();
          const source = await response.text();
          const marker = "}) {\n  return i || r\n    ? `login`";
          assert.ok(source.includes(marker), "locate Desktop startup decision");
          return route.fulfill({
            response,
            body: source.replace(
              marker,
              "}) {\n  window.__CODEX_CI_STARTUP__ = arguments[0];\n  return i || r\n    ? `login`",
            ),
          });
        }
        if (/\/onboarding-page-[^/]+\.js$/.test(url.pathname)) {
          const response = await route.fetch();
          const source = await format(await response.text(), {
            parser: "babel",
          });
          const marker =
            /isLoading:\s*g\s*\|\|\s*\(l\s*&&\s*d\)\s*\|\|\s*t\s*\|\|\s*p\s*\|\|\s*\(n\s*!==\s*`welcome`\s*&&\s*!r\s*&&\s*e\s*==\s*null\)/;
          assert.ok(marker.test(source), "locate Desktop onboarding readiness");
          return route.fulfill({
            response,
            body: source
              .replace(
                marker,
                (match) =>
                  `isLoading: (window.__CODEX_CI_ONBOARDING__ = { previous: e, advancing: t, override: n, welcomePending: r, chatgpt: l, contextLoading: d, statsigLoading: p, teenLoading: g }, ${match.slice(match.indexOf(":") + 1)})`,
              )
              .replace(
                "  switch (n) {\n    case Z.Start:",
                "  window.__CODEX_CI_ONBOARDING_STEP__ = n;\n  switch (n) {\n    case Z.Start:",
              )
              .replace(
                "  let w = r && f ? o : void 0,",
                "  window.__CODEX_CI_SPLASH__ = { showSplash: r, focused: u, waitForFocus: c, animate: f };\n  let w = r && f ? o : void 0,",
              ),
          });
        }
        return route.continue();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      // Model promotions can appear after the saved chat is already visible.
      // Dismiss the real first-run overlay whenever it blocks an action, while
      // retaining the fixture's model instead of accepting the advertised one.
      await page.addLocatorHandler(
        page.getByRole("button", {
          name: "Continue with current model",
          exact: true,
        }),
        async (button) => {
          await button.click();
          console.log(
            `Cold start ${startupRun}: dismissed real model promotion`,
          );
        },
      );
      const errors = [];
      const diagnostics = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (message) => {
        if (message.type() === "error")
          diagnostics.push(message.text().slice(0, 500));
      });
      page.on("requestfailed", (request) => {
        if (new URL(request.url()).hostname === "127.0.0.1") {
          diagnostics.push(`${request.url()}: ${request.failure()?.errorText}`);
        }
      });
      try {
        await page.goto(base + "thread/" + threadId);
        // Fresh Desktop state can open its first-run occupation wizard. Complete
        // that normal UI step, then restore the requested local thread route.
        await until(
          async () =>
            (await page
              .getByText("What type of work do you do?", { exact: true })
              .isVisible()) ||
            (await page
              .getByText("CI assistant response 1", { exact: true })
              .first()
              .isVisible()),
          "Desktop first-run screen or saved chat",
          45000,
        );
        const readiness = await page.evaluate(() => ({
          startup: window.__CODEX_CI_STARTUP__,
          onboarding: window.__CODEX_CI_ONBOARDING__,
          step: window.__CODEX_CI_ONBOARDING_STEP__,
          splash: window.__CODEX_CI_SPLASH__,
        }));
        console.log(
          `Cold start ${startupRun} readiness: ${JSON.stringify(readiness)}`,
        );
        assert.equal(
          readiness.startup.projectlessOnboardingCompleted,
          false,
          "each cold start uses fresh Desktop onboarding state",
        );
        if (
          await page
            .getByText("What type of work do you do?", { exact: true })
            .isVisible()
        ) {
          for (let step = 0; step < 8; step++) {
            const skip = page
              .getByRole("button", {
                name: /^(Skip|Skip setup|Skip for now|Not now)$/i,
              })
              .last();
            if (!(await skip.isVisible())) break;
            const before = await page.locator("body").innerText();
            await skip.click();
            await until(
              async () => (await page.locator("body").innerText()) !== before,
              "optional onboarding advances",
              10000,
            );
          }
        }
        await page.evaluate(
          (id) =>
            window.dispatchEvent(
              new MessageEvent("message", {
                data: { type: "navigate-to-route", path: `/local/${id}` },
              }),
            ),
          threadId,
        );
        await page
          .getByText("CI assistant response 1", { exact: true })
          .first()
          .waitFor({ timeout: 45000 });
        const composer = page
          .locator('[contenteditable="true"]:visible')
          .first();
        await composer.waitFor({ timeout: 45000 });
        await composer.fill(
          "Continue the saved conversation in the real browser.",
        );
        // Use the real mobile Send action. Its actionability check also lets
        // the handler above dismiss a late model promotion before submitting.
        await page.getByRole("button", { name: "Send", exact: true }).click();
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
        // A mobile toolbar/keyboard can shrink only the visual viewport while
        // the Desktop's 100vh layout stays tall. Exercise that real root layout.
        await page.evaluate(() => {
          Object.defineProperty(window.visualViewport, "height", {
            configurable: true,
            value: 400,
          });
          window.visualViewport.dispatchEvent(new Event("resize"));
        });
        await until(async () => {
          const b = await composer.boundingBox();
          return b && b.y >= 0 && b.y + b.height <= 401;
        }, "composer follows the visual viewport");
        await page.evaluate(() => {
          delete window.visualViewport.height;
          window.visualViewport.dispatchEvent(new Event("resize"));
        });
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
          .waitFor({ timeout: 45000 });
        await page.evaluate(() =>
          window.dispatchEvent(
            new MessageEvent("message", {
              data: {
                type: "navigate-to-route",
                path: "/settings/connections/computer",
              },
            }),
          ),
        );
        await page
          .getByText("Devices that can control this PC", { exact: true })
          .waitFor();
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
        const artifact = `scratch/integration-results/desktop-cold-start-${startupRun}`;
        await fs.mkdir("scratch/integration-results", { recursive: true });
        await fs.writeFile(
          `${artifact}-rpc.json`,
          JSON.stringify(gateway.traffic, null, 2),
        );
        await page.screenshot({
          path: `${artifact}.png`,
        });
        await fs.writeFile(`${artifact}.html`, await page.content());
        throw new Error(
          `${e.message}\nStartup: ${JSON.stringify(await page.evaluate(() => window.__CODEX_CI_STARTUP__))}\nOnboarding: ${JSON.stringify(await page.evaluate(() => window.__CODEX_CI_ONBOARDING__))}\nStep: ${JSON.stringify(await page.evaluate(() => ({ step: window.__CODEX_CI_ONBOARDING_STEP__, splash: window.__CODEX_CI_SPLASH__ })))}\nRPC: ${JSON.stringify(gateway.traffic)}\nURL: ${page.url()}\nBrowser: ${diagnostics.slice(-15).join("\n")}\nPage: ${(await page.locator("body").innerText()).slice(-5000)}\nErrors: ${errors.join("\n")}\nBackend: ${backend.log()}\nApp-server: ${appServer.log()}`,
          { cause: e },
        );
      }
    },
  );
