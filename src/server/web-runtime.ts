// Docker/web-fork integration. Keep policy and presentation out of main.ts.
import fs from "node:fs/promises";
import net from "node:net";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { ServerResponse } from "node:http";
import { pathAtBase } from "./base-path";

type Status = {
  phase: string;
  updatedAt: number;
  attempt?: number;
  retryAt?: number;
  completed?: number;
  total?: number;
  failedThreads?: number;
};
const phases = new Set([
  "connecting",
  "retry-wait",
  "connected",
  "resuming",
  "ready",
  "degraded",
  "failed",
]);

export async function installWebRuntime(
  app: FastifyInstance,
  basePath: string,
  html: string,
): Promise<string> {
  const assets = path.resolve(__dirname, "../../docker/browser");
  for (const [file, type] of [
    ["runtime.js", "text/javascript"],
    ["runtime.css", "text/css"],
  ] as const) {
    const body = await fs.readFile(path.join(assets, file), "utf8");
    app.get(
      pathAtBase(basePath, `__backend/${file}`),
      async (_request, reply) =>
        reply
          .header("Cache-Control", "no-cache")
          .type(`${type}; charset=utf-8`)
          .send(body),
    );
  }
  const enabled = Boolean(process.env.CODEX_APP_SERVER_URL);
  let status: Status = { phase: "backend-ready", updatedAt: Date.now() };
  const history: Status[] = [status];
  const streams = new Set<ServerResponse>();
  const snapshot = () => ({
    enabled,
    backendReady: true,
    ...status,
    serverTime: Date.now(),
    history,
  });
  const send = (stream: ServerResponse) => {
    // Slow/disconnected clients reconnect and receive a fresh snapshot.
    if (!stream.write(`data: ${JSON.stringify(snapshot())}\n\n`)) stream.end();
  };
  const publish = (next: Status) => {
    status = next;
    if (history.at(-1)?.phase === next.phase)
      history[history.length - 1] = next;
    else history.push(next);
    if (history.length > 8) history.shift();
    for (const stream of streams) send(stream);
  };
  app.get(pathAtBase(basePath, "__backend/status"), async (_request, reply) =>
    reply.header("Cache-Control", "no-store").send(snapshot()),
  );
  app.get(pathAtBase(basePath, "__backend/status/events"), (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    streams.add(reply.raw);
    send(reply.raw);
    reply.raw.on("close", () => streams.delete(reply.raw));
  });
  const heartbeat = setInterval(() => {
    for (const stream of streams) stream.write(": heartbeat\n\n");
  }, 15_000);
  heartbeat.unref();
  const connections = new Map<net.Socket, Status>();
  let server: net.Server | undefined;
  let address: string | undefined;
  const previousAddress = process.env.CODEX_WEB_STATUS_ADDRESS;
  if (enabled) {
    const token = randomBytes(32).toString("hex");
    server = net.createServer((socket) => {
      let buffer = "";
      let authenticated = false;
      socket.setTimeout(5000, () => socket.destroy());
      socket.setEncoding("utf8");
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          if (newline > 8192) {
            socket.destroy();
            return;
          }
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const value = JSON.parse(line);
            if (!authenticated) {
              if (value.token !== token) {
                socket.destroy();
                return;
              }
              authenticated = true;
              socket.setTimeout(0);
              connections.set(socket, {
                phase: "connecting",
                updatedAt: Date.now(),
              });
              continue;
            }
            if (!phases.has(value.phase)) continue;
            const next: Status = { phase: value.phase, updatedAt: Date.now() };
            for (const key of [
              "attempt",
              "retryAt",
              "completed",
              "total",
              "failedThreads",
            ] as const) {
              if (Number.isSafeInteger(value[key]) && value[key] >= 0)
                next[key] = value[key];
            }
            connections.set(socket, next);
            // If multiple managed proxies exist, never hide one still waiting.
            const waiting = [...connections.values()].find(
              (item) => item.phase !== "ready",
            );
            publish(waiting ?? next);
          } catch {
            /* Ignore malformed status data, never app-server RPC. */
          }
        }
        if (buffer.length > 8192) socket.destroy();
      });
      socket.on("close", () => {
        const last = connections.get(socket);
        connections.delete(socket);
        if (last)
          publish(
            [...connections.values()].find((item) => item.phase !== "ready") ??
              [...connections.values()].at(-1) ?? {
                phase: "failed",
                updatedAt: Date.now(),
              },
          );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => {
        server!.off("error", reject);
        resolve();
      });
    });
    address = `${(server.address() as net.AddressInfo).port}:${token}`;
    process.env.CODEX_WEB_STATUS_ADDRESS = address;
  }
  app.addHook("preClose", async () => {
    for (const stream of streams) stream.end();
    streams.clear();
  });
  app.addHook("onClose", async () => {
    clearInterval(heartbeat);
    for (const stream of streams) stream.end();
    for (const socket of connections.keys()) socket.destroy();
    connections.clear();
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (address && process.env.CODEX_WEB_STATUS_ADDRESS === address) {
      if (previousAddress)
        process.env.CODEX_WEB_STATUS_ADDRESS = previousAddress;
      else delete process.env.CODEX_WEB_STATUS_ADDRESS;
    }
  });
  // Absolute paths survive direct navigation to nested routes. The base path
  // has already been validated; HTML-escape it as it may contain ampersands.
  const prefix = basePath
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return html.replace(
    "</head>",
    `<link rel="stylesheet" href="${prefix}__backend/runtime.css" />\n<script defer src="${prefix}__backend/runtime.js"></script>\n</head>`,
  );
}
