import net from "node:net";
import { WebSocket } from "ws";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export async function startRemotePairing(
  endpoint: string,
  createSocket: (socketPath: string) => WebSocket = (socketPath) =>
    new WebSocket("ws://localhost/rpc", {
      createConnection: () => net.createConnection(socketPath),
      perMessageDeflate: false,
      handshakeTimeout: 10_000,
    }),
): Promise<{
  code: string;
  expiresAt: number;
}> {
  if (!endpoint.startsWith("unix:///")) {
    throw new Error("Remote pairing requires a Unix app-server socket");
  }

  const socket = createSocket(endpoint.slice("unix://".length));
  const pending = new Map<number, Pending>();
  let nextId = 0;

  socket.on("message", (data) => {
    let message: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    const request = pending.get(message.id ?? -1);
    if (!request) return;
    pending.delete(message.id!);
    clearTimeout(request.timer);
    if (message.error)
      request.reject(new Error(message.error.message || "App-server error"));
    else request.resolve(message.result);
  });
  socket.on("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("App-server connection closed"));
    }
    pending.clear();
  });

  function call(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(
        JSON.stringify({
          id,
          method,
          ...(params === undefined ? {} : { params }),
        }),
      );
    });
  }

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
      socket.once("close", () =>
        reject(new Error("App-server connection closed")),
      );
    });
    await call("initialize", {
      clientInfo: { name: "codex-web-mobile-pairing", version: "1" },
      capabilities: { experimentalApi: true },
    });
    socket.send(JSON.stringify({ method: "initialized" }));
    await call("remoteControl/enable", { ephemeral: true });
    const result = await call("remoteControl/pairing/start", {
      manualCode: true,
    });
    if (!result || typeof result !== "object")
      throw new Error("Invalid pairing response");
    const { manualPairingCode, expiresAt } = result as Record<string, unknown>;
    if (
      typeof manualPairingCode !== "string" ||
      !manualPairingCode ||
      typeof expiresAt !== "number" ||
      !Number.isFinite(expiresAt)
    ) {
      throw new Error("App-server did not return a pairing code and expiry");
    }
    return { code: manualPairingCode, expiresAt };
  } finally {
    for (const request of pending.values()) clearTimeout(request.timer);
    pending.clear();
    socket.close();
  }
}
