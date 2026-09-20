import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { WebSocket } from "ws";
import locale from "../src/server/electron/locale.js";
import electron from "../src/server/electron/index.js";
import server from "../src/server/main.js";

test("normalizes browser and POSIX locales and ignores invalid or automatic values", () => {
  assert.deepEqual(
    locale.normalizeLanguages(
      "de_DE.UTF-8,de-DE,fr;q=0.9,en-US;q=0,invalid_!,auto,C.UTF-8",
    ),
    ["de-DE", "fr"],
  );
});
test("system locale supplies a real fallback outside browser requests", () => {
  const previous = process.env.LC_ALL;
  process.env.LC_ALL = "fr_FR.UTF-8";
  try {
    assert.equal(electron.app.getLocale(), "fr-FR");
  } finally {
    if (previous) process.env.LC_ALL = previous;
    else delete process.env.LC_ALL;
  }
});
test(
  "browser locale stays isolated across concurrent asynchronous IPC requests",
  { timeout: 5000 },
  async (t) => {
    const app = await server.startIpcBridgeServer(
      { basePath: "/", host: "127.0.0.1", port: 0 },
      { startMainApp: false },
    );
    t.after(() => app.close());
    globalThis.__codexElectronIpcBridge.setRendererWindowFactory(async () => {
      await delay(10);
      return new electron.BrowserWindow({ show: false });
    });
    electron.ipcMain.handle("test-locale", async () => {
      await delay(20);
      return {
        locale: electron.app.getLocale(),
        system: electron.app.getSystemLocale(),
        languages: electron.app.getPreferredSystemLanguages(),
      };
    });
    async function request(language) {
      const ws = new WebSocket(
        `ws://127.0.0.1:${app.server.address().port}/__backend/ipc?locale=${language}`,
      );
      await once(ws, "open");
      const response = once(ws, "message");
      ws.send(
        JSON.stringify({
          type: "ipc-renderer-invoke",
          channel: "test-locale",
          args: [],
          requestId: language,
        }),
      );
      const result = JSON.parse(String((await response)[0])).result;
      ws.close();
      return result;
    }
    const [de, fr] = await Promise.all([
      request("de-DE,en-US"),
      request("fr-FR"),
    ]);
    assert.deepEqual(de, {
      locale: "de-DE",
      system: "de-DE",
      languages: ["de-DE", "en-US"],
    });
    assert.equal(fr.locale, "fr-FR");
  },
);
test("Electron tracing is silent by default and explicitly opt-in", () => {
  const previous = process.env.CODEX_WEB_ELECTRON_DEBUG;
  const original = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args);
  try {
    delete process.env.CODEX_WEB_ELECTRON_DEBUG;
    electron.BrowserWindow.getAllWindows();
    electron.app.getLocale();
    assert.equal(logs.length, 0);
    process.env.CODEX_WEB_ELECTRON_DEBUG = "1";
    electron.BrowserWindow.getAllWindows();
    assert.match(logs[0][0], /electron-main-stub/);
  } finally {
    console.log = original;
    if (previous) process.env.CODEX_WEB_ELECTRON_DEBUG = previous;
    else delete process.env.CODEX_WEB_ELECTRON_DEBUG;
  }
});
