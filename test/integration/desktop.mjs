import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { chromium } from "playwright";
import { appServerFixture, childProcess, until } from "./support.mjs";

test(
  "real Desktop renders the mobile composer and profile Help menu",
  { timeout: 90000 },
  async (t) => {
    const appServer = await appServerFixture(t);
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
        CODEX_APP_SERVER_URL: appServer.endpoint,
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
      await page.goto(base);
      const composer = page.locator('[contenteditable="true"]').first();
      await composer.waitFor({ timeout: 45000 });
      await composer.fill("Draft retained across mobile resizing");
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
      console.log(
        "DESKTOP BUTTONS",
        await page.getByRole("button").allTextContents(),
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
