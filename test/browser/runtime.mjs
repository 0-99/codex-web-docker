import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import Fastify from "fastify";
import { chromium } from "playwright";
import runtime from "../../src/server/web-runtime.js";
import { createStatusReporter } from "../../docker/proxy-status.mjs";

const launch = {
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? {
        executablePath: path.resolve(
          process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        ),
        args: JSON.parse(process.env.PLAYWRIGHT_CHROMIUM_ARGS || "[]"),
      }
    : {}),
};

test(
  "startup status, countdown, reconnect and mobile composer in a real browser",
  { timeout: 30000 },
  async (t) => {
    const previous = process.env.CODEX_APP_SERVER_URL;
    process.env.CODEX_APP_SERVER_URL = "ws://127.0.0.1:9";
    const app = Fastify();
    let browser, reporter;
    t.after(async () => {
      reporter?.close();
      await browser?.close();
      await app.close();
      if (previous) process.env.CODEX_APP_SERVER_URL = previous;
      else delete process.env.CODEX_APP_SERVER_URL;
    });
    const html = await runtime.installWebRuntime(
      app,
      "/nested/",
      `<!doctype html>
    <html lang="en"><head><meta charset="utf-8"><base href="/nested/"><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      /* Upstream's viewport rule plus the chat's flex/scroll structure. */
      body { margin: 0; height: 100vh; } #root { height: 100vh; }
      .main-surface { height: 100%; display: flex; flex-direction: column; }
      .startup-loader { height: 100%; display: grid; place-items: center; }
      .messages { flex: 1; min-height: 0; overflow: auto; }
      textarea { box-sizing: border-box; height: 72px; flex-shrink: 0; width: 100%; }
    </style></head><body><div id="root"><div class="startup-loader">Codex</div></div></body></html>`,
    );
    app.get("/nested/", (_, reply) => reply.type("text/html").send(html));
    await app.listen({ host: "127.0.0.1", port: 0 });
    browser = await chromium.launch(launch);
    const context = await browser.newContext({
      viewport: { width: 393, height: 740 },
      isMobile: true,
      deviceScaleFactor: 1,
      locale: "de-DE",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(4000);
    reporter = createStatusReporter();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${app.server.address().port}/nested/`);
    await page
      .getByRole("status")
      .filter({ hasText: "Web-Backend bereit" })
      .waitFor();
    reporter.update("retry-wait", { attempt: 1, retryAt: Date.now() + 3000 });
    await page
      .getByText("App-Server nicht erreichbar · wir warten weiter", {
        exact: true,
      })
      .first()
      .waitFor();
    await page.getByText("Nächster Versuch in 2 s", { exact: true }).waitFor();
    reporter.update("connected");
    reporter.update("resuming", { completed: 1, total: 2 });
    await page.getByText("1 von 2 Threads wiederhergestellt").waitFor();
    reporter.update("ready");
    await page
      .getByText("App-Server verbunden · Oberfläche wird geladen …", {
        exact: true,
      })
      .waitFor();
    await page.evaluate(() => {
      document.querySelector("#root").innerHTML =
        '<main class="main-surface"><header>Codex</header><div class="messages"><div style="height:2000px">Conversation</div></div><textarea aria-label="Message"></textarea></main>';
    });
    await page.locator("#codex-web-status").waitFor({ state: "hidden" });
    const composer = page.getByRole("textbox");
    await composer.fill("Unsent draft");
    async function assertComposerVisible() {
      const bounds = await composer.boundingBox();
      const viewportHeight = await page.evaluate(
        () => window.visualViewport.height,
      );
      assert.ok(
        bounds.y >= 0 && bounds.y + bounds.height <= viewportHeight + 1,
      );
      assert.equal(await composer.inputValue(), "Unsent draft");
    }
    await assertComposerVisible();
    // Browser toolbar/orientation changes and keyboard-sized visible area.
    await page.setViewportSize({ width: 393, height: 380 });
    await page.waitForFunction(
      () =>
        document.documentElement.style.getPropertyValue(
          "--codex-web-viewport-height",
        ) === "380px",
    );
    await assertComposerVisible();
    // Returning from the back/forward cache must reopen the status stream.
    await page.evaluate(() => {
      window.dispatchEvent(
        new PageTransitionEvent("pagehide", { persisted: true }),
      );
      window.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted: true }),
      );
    });
    reporter.update("retry-wait", { attempt: 1, retryAt: Date.now() + 10000 });
    await page.locator("#codex-web-status").waitFor({ state: "visible" });
    await assertComposerVisible();
    reporter.update("ready");
    await page.locator("#codex-web-status").waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForFunction(
      () =>
        !document.documentElement.style.getPropertyValue(
          "--codex-web-viewport-height",
        ),
    );
    await assertComposerVisible();
    assert.deepEqual(errors, []);
  },
);
