import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { installWebAuth } from "../src/server/web-auth.js";

test("first-run setup and login protect HTTP and IPC across restarts", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-web-auth-"));
  const previous = {
    enabled: process.env.CODEX_WEB_AUTH_ENABLED,
    directory: process.env.CODEX_WEB_AUTH_DIR,
  };
  process.env.CODEX_WEB_AUTH_ENABLED = "1";
  process.env.CODEX_WEB_AUTH_DIR = directory;
  t.after(async () => {
    if (previous.enabled === undefined)
      delete process.env.CODEX_WEB_AUTH_ENABLED;
    else process.env.CODEX_WEB_AUTH_ENABLED = previous.enabled;
    if (previous.directory === undefined) delete process.env.CODEX_WEB_AUTH_DIR;
    else process.env.CODEX_WEB_AUTH_DIR = previous.directory;
    await fs.rm(directory, { recursive: true, force: true });
  });
  let code;
  const originalLog = console.log;
  console.log = (...args) => {
    const message = args.join(" ");
    if (message.includes("First-run setup code:"))
      code = message.split(": ").at(-1);
    else originalLog(...args);
  };
  const start = async () => {
    const app = Fastify();
    const allowWebSocket = await installWebAuth(app, "/codex/");
    app.get("/codex/__backend/status", async () => ({ ok: true }));
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    return { app, origin: `http://127.0.0.1:${address.port}`, allowWebSocket };
  };
  let { app, origin, allowWebSocket } = await start();
  console.log = originalLog;
  t.after(() => app.close());
  assert.match(code, /^[\w-]{32}$/u);
  const base = `${origin}/codex/`;
  const get = (relative, options = {}) =>
    fetch(`${base}${relative}`, { redirect: "manual", ...options });
  assert.equal(
    (
      await get("__backend/status", { headers: { Accept: "text/html" } })
    ).headers.get("location"),
    "/codex/__auth/setup",
  );
  assert.equal((await get("__backend/status")).status, 401);
  assert.equal(
    allowWebSocket({ headers: { host: new URL(origin).host, origin } }),
    false,
  );
  const post = (relative, body, cookie) =>
    get(relative, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await post("__auth/setup", {
        code: "wrong",
        username: "admin",
        password: "very-long-password",
      })
    ).status,
    400,
  );
  const setup = await post("__auth/setup", {
    code,
    username: "admin",
    password: "very-long-password",
  });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (await get("__backend/status", { headers: { Cookie: cookie } })).status,
    200,
  );
  assert.equal(
    allowWebSocket({ headers: { host: new URL(origin).host, origin, cookie } }),
    true,
  );
  assert.equal(
    allowWebSocket({
      headers: {
        host: new URL(origin).host,
        origin: "https://evil.example",
        cookie,
      },
    }),
    false,
  );
  assert.equal(
    (await fs.stat(path.join(directory, "credentials.json"))).mode & 0o777,
    0o600,
  );
  assert.doesNotMatch(
    await fs.readFile(path.join(directory, "credentials.json"), "utf8"),
    /very-long-password/u,
  );
  assert.equal((await post("__auth/logout", {}, cookie)).status, 200);
  assert.equal(
    (await get("__backend/status", { headers: { Cookie: cookie } })).status,
    401,
  );
  await app.close();
  ({ app, origin, allowWebSocket } = await start());
  const restartedBase = `${origin}/codex/`;
  const login = (password) =>
    fetch(`${restartedBase}__auth/login`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password }),
    });
  assert.equal((await login("wrong-password")).status, 401);
  const result = await login("very-long-password");
  assert.equal(result.status, 200);
  const newCookie = result.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (
      await fetch(`${restartedBase}__backend/status`, {
        headers: { Cookie: newCookie },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${restartedBase}__backend/status`, {
        headers: { Cookie: cookie },
      })
    ).status,
    401,
  );
  assert.equal(
    allowWebSocket({
      headers: { host: new URL(origin).host, origin, cookie: newCookie },
    }),
    true,
  );
});
