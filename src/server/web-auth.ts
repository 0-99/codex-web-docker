import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { pathAtBase } from "./base-path";

const scrypt = promisify(scryptCallback);
const lifetimeMs = 12 * 60 * 60 * 1000;
type Credentials = { username: string; salt: string; hash: string };

function equal(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function page(title: string, fields: string, action: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Codex Web</title><style>body{font:16px system-ui;background:#f5f5f3;color:#20201e;min-height:100vh;display:grid;place-items:center;margin:0}main{background:white;padding:2rem;border-radius:16px;box-shadow:0 8px 35px #0001;width:min(380px,calc(100vw - 4rem))}h1{font-size:1.5rem}label{display:block;margin:1rem 0}input{box-sizing:border-box;width:100%;padding:.7rem;margin-top:.35rem;font:inherit}button{padding:.7rem 1rem;font:inherit;cursor:pointer}p{line-height:1.5}#error{color:#a20;min-height:1.5em}</style></head><body><main><h1>${title}</h1><p>Access to this Codex instance is protected.</p><form id="auth">${fields}<button type="submit">Continue</button><p id="error" role="alert"></p></form></main><script>document.getElementById('auth').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget;const data=Object.fromEntries(new FormData(form));const response=await fetch(${JSON.stringify(action)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});if(response.ok){location.replace(${JSON.stringify(action.replace(/__auth\/(setup|login)$/, ""))});return}document.getElementById('error').textContent=response.status===429?'Too many attempts. Try again later.':'Invalid details. Check your entries.'})</script></body></html>`;
}

function sameOrigin(request: FastifyRequest): boolean {
  try {
    return (
      request.headers["sec-fetch-site"] !== "cross-site" &&
      new URL(request.headers.origin ?? "").host === request.headers.host
    );
  } catch {
    return false;
  }
}

export async function installWebAuth(
  app: FastifyInstance,
  basePath: string,
): Promise<(request: IncomingMessage) => boolean> {
  const enabled = process.env.CODEX_WEB_AUTH_ENABLED ?? "0";
  if (enabled === "0") return () => true;
  if (enabled !== "1") throw new Error("CODEX_WEB_AUTH_ENABLED must be 0 or 1");
  const secure = process.env.CODEX_WEB_AUTH_COOKIE_SECURE ?? "0";
  if (secure !== "0" && secure !== "1")
    throw new Error("CODEX_WEB_AUTH_COOKIE_SECURE must be 0 or 1");
  const directory = process.env.CODEX_WEB_AUTH_DIR || "/data/auth";
  const file = path.join(directory, "credentials.json");
  let credentials: Credentials | undefined;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as Credentials).username !== "string" ||
      !/^[0-9a-f]{32}$/u.test((parsed as Credentials).salt) ||
      !/^[0-9a-f]{128}$/u.test((parsed as Credentials).hash)
    ) {
      throw new Error("Invalid credentials file");
    }
    credentials = parsed as Credentials;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const setupCode = credentials
    ? undefined
    : randomBytes(24).toString("base64url");
  if (setupCode) console.log(`[web-auth] First-run setup code: ${setupCode}`);
  const setupPath = pathAtBase(basePath, "__auth/setup");
  const loginPath = pathAtBase(basePath, "__auth/login");
  const logoutPath = pathAtBase(basePath, "__auth/logout");
  const logoutScriptPath = pathAtBase(basePath, "__auth/logout.js");
  const cookieName = "codex_web_session";
  const cookieAttributes = `Path=${basePath}; HttpOnly; SameSite=Lax${secure === "1" ? "; Secure" : ""}`;
  const sessions = new Map<string, number>();
  const failures = new Map<string, { count: number; until: number }>();
  const sessionKey = (token: string) =>
    createHash("sha256").update(token).digest("hex");
  const authorized = (cookie: string | undefined) => {
    const token = cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    if (!token || !/^[\w-]{43}$/u.test(token)) return false;
    const key = sessionKey(token);
    const expiry = sessions.get(key);
    if (!expiry) return false;
    if (expiry <= Date.now()) {
      sessions.delete(key);
      return false;
    }
    return true;
  };
  const attempt = (address: string) => {
    const now = Date.now();
    const entry = failures.get(address);
    if (entry && entry.until > now && entry.count >= 5) return false;
    failures.set(address, {
      count: (entry?.until ?? 0) > now ? entry!.count + 1 : 1,
      until: now + 60_000,
    });
    return true;
  };
  const issue = (reply: {
    header: (name: string, value: string) => unknown;
  }) => {
    const token = randomBytes(32).toString("base64url");
    sessions.set(sessionKey(token), Date.now() + lifetimeMs);
    reply.header(
      "Set-Cookie",
      `${cookieName}=${token}; ${cookieAttributes}; Max-Age=${lifetimeMs / 1000}`,
    );
  };

  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === setupPath || pathname === loginPath) return;
    if (authorized(request.headers.cookie)) return;
    if (
      request.method === "GET" &&
      (request.headers.accept ?? "").includes("text/html")
    ) {
      return reply.redirect(credentials ? loginPath : setupPath);
    }
    return reply.code(401).send({ error: "Authentication required" });
  });
  app.get(setupPath, async (_request, reply) => {
    if (credentials) return reply.redirect(loginPath);
    return reply
      .type("text/html")
      .send(
        page(
          "Set up Codex Web",
          '<label>Setup code<input name="code" autocomplete="off" required></label><label>Username<input name="username" autocomplete="username" required></label><label>Password (at least 12 characters)<input type="password" name="password" autocomplete="new-password" minlength="12" required></label>',
          setupPath,
        ),
      );
  });
  app.post(setupPath, async (request, reply) => {
    if (credentials)
      return reply.code(409).send({ error: "Already configured" });
    if (!sameOrigin(request))
      return reply.code(403).send({ error: "Same-origin request required" });
    const address = request.ip;
    if (!attempt(address))
      return reply.code(429).send({ error: "Too many attempts" });
    const body = request.body as Record<string, unknown> | null;
    const code = body?.code;
    const username = body?.username;
    const password = body?.password;
    if (
      typeof code !== "string" ||
      !setupCode ||
      !equal(code, setupCode) ||
      typeof username !== "string" ||
      username.length < 1 ||
      username.length > 64 ||
      typeof password !== "string" ||
      password.length < 12 ||
      password.length > 1024
    ) {
      return reply.code(400).send({ error: "Invalid setup details" });
    }
    const salt = randomBytes(16).toString("hex");
    const hash = (
      (await scrypt(password, Buffer.from(salt, "hex"), 64)) as Buffer
    ).toString("hex");
    const value: Credentials = { username, salt, hash };
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(
      directory,
      `.credentials-${randomBytes(8).toString("hex")}`,
    );
    try {
      await fs.writeFile(temporary, JSON.stringify(value), {
        flag: "wx",
        mode: 0o600,
      });
      await fs.link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        return reply.code(409).send({ error: "Already configured" });
      throw error;
    } finally {
      await fs.rm(temporary, { force: true });
    }
    credentials = value;
    failures.delete(address);
    issue(reply);
    return reply.send({ ok: true });
  });
  app.get(loginPath, async (_request, reply) => {
    if (!credentials) return reply.redirect(setupPath);
    return reply
      .type("text/html")
      .send(
        page(
          "Sign in to Codex Web",
          '<label>Username<input name="username" autocomplete="username" required></label><label>Password<input type="password" name="password" autocomplete="current-password" required></label>',
          loginPath,
        ),
      );
  });
  app.post(loginPath, async (request, reply) => {
    if (!credentials) return reply.code(409).send({ error: "Setup required" });
    if (!sameOrigin(request))
      return reply.code(403).send({ error: "Same-origin request required" });
    const address = request.ip;
    if (!attempt(address))
      return reply.code(429).send({ error: "Too many attempts" });
    const body = request.body as Record<string, unknown> | null;
    const username = body?.username;
    const password = body?.password;
    if (typeof password !== "string" || password.length > 1024)
      return reply.code(401).send({ error: "Invalid credentials" });
    const candidate = (await scrypt(
      password,
      Buffer.from(credentials.salt, "hex"),
      64,
    )) as Buffer;
    if (
      typeof username !== "string" ||
      !equal(username, credentials.username) ||
      !timingSafeEqual(candidate, Buffer.from(credentials.hash, "hex"))
    ) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }
    failures.delete(address);
    issue(reply);
    return reply.send({ ok: true });
  });
  app.post(logoutPath, async (request, reply) => {
    if (!sameOrigin(request))
      return reply.code(403).send({ error: "Same-origin request required" });
    const token = request.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    if (token) sessions.delete(sessionKey(token));
    reply.header(
      "Set-Cookie",
      `${cookieName}=; ${cookieAttributes}; Max-Age=0`,
    );
    return reply.send({ ok: true });
  });
  app.get(logoutScriptPath, async (_request, reply) =>
    reply.type("text/javascript").send(`(() => {
    const button = document.createElement("button");
    button.textContent = navigator.language.startsWith("de") ? "Abmelden" : "Sign out";
    button.setAttribute("aria-label", button.textContent);
    button.style.cssText = "position:fixed;bottom:12px;right:12px;z-index:2147483647;padding:6px 10px;border:1px solid #888;border-radius:8px;background:#fff;color:#222;cursor:pointer;font:12px system-ui";
    button.addEventListener("click", async () => {
      const response = await fetch(${JSON.stringify(logoutPath)}, { method: "POST", credentials: "same-origin" });
      if (response.ok) location.replace(${JSON.stringify(loginPath)});
    });
    document.body.append(button);
  })();`),
  );
  return (request) => {
    if (!authorized(request.headers.cookie)) return false;
    try {
      return Boolean(
        request.headers.origin &&
        new URL(request.headers.origin).host === request.headers.host,
      );
    } catch {
      return false;
    }
  };
}
