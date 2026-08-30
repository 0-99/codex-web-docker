import assert from "node:assert/strict";
import test from "node:test";

import { WebSocket } from "ws";
import serverModule from "../src/server/main.js";

const { startIpcBridgeServer } = serverModule;

async function startServer(t, basePath) {
  const app = await startIpcBridgeServer(
    { basePath, host: "127.0.0.1", port: 0 },
    { startMainApp: false },
  );
  t.after(() => app.close());

  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("serves the complete application below a configured base path", async (t) => {
  const origin = await startServer(t, "/my/example/subdir/");
  const applicationUrl = `${origin}/my/example/subdir/`;

  const rootResponse = await fetch(`${origin}/`);
  assert.equal(rootResponse.status, 404);

  const redirectResponse = await fetch(
    `${origin}/my/example/subdir?source=test`,
    { redirect: "manual" },
  );
  assert.equal(redirectResponse.status, 302);
  assert.equal(
    redirectResponse.headers.get("location"),
    "/my/example/subdir/?source=test",
  );

  const indexResponse = await fetch(applicationUrl);
  assert.equal(indexResponse.status, 200);
  const indexHtml = await indexResponse.text();
  assert.match(indexHtml, /<base href="\/my\/example\/subdir\/" \/>/);
  assert.match(
    indexHtml,
    /<link rel="manifest" href="\/my\/example\/subdir\/manifest\.json" \/>/,
  );

  assert.equal((await fetch(`${applicationUrl}assets/preload.js`)).status, 200);
  assert.equal((await fetch(`${applicationUrl}thread/example`)).status, 200);
  assert.equal(
    (await fetch(`${applicationUrl}__backend/upload`, { method: "POST" }))
      .status,
    400,
  );
  assert.equal(
    (await fetch(`${origin}/__backend/upload`, { method: "POST" })).status,
    404,
  );

  const manifest = await (await fetch(`${applicationUrl}manifest.json`)).json();
  assert.equal(manifest.start_url, ".");
  assert.equal(manifest.scope, ".");
  assert.equal(manifest.share_target.action, "share/receive");
  assert.equal(manifest.icons[0].src, "assets/pwa-icon-512.png");

  await new Promise((resolve, reject) => {
    const socket = new WebSocket(
      applicationUrl.replace(/^http/u, "ws") + "__backend/ipc",
    );
    socket.addEventListener("open", () => {
      socket.close();
      resolve();
    });
    socket.addEventListener("error", reject);
  });
});

test("keeps serving the application at the root by default", async (t) => {
  const origin = await startServer(t, "/");
  const response = await fetch(`${origin}/`);

  assert.equal(response.status, 200);
  assert.match(await response.text(), /<base href="\/" \/>/);
});
