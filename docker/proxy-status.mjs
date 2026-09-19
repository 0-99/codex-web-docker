import net from "node:net";

// A private, local side channel: stdout remains exclusively app-server JSONL.
export function createStatusReporter(
  address = process.env.CODEX_WEB_STATUS_ADDRESS,
) {
  if (!address) return { update() {}, close() {} };
  let latest;
  const [port, token] = address.split(":");
  const socket = net.createConnection({
    host: "127.0.0.1",
    port: Number(port),
  });
  socket.unref();
  socket.on("error", () => {}); // Status reporting must never break RPC transport.
  socket.on("connect", () => {
    socket.write(JSON.stringify({ token }) + "\n");
    if (latest) socket.write(JSON.stringify(latest) + "\n");
  });
  return {
    update(phase, details = {}) {
      latest = { phase, ...details };
      if (!socket.connecting && !socket.destroyed)
        socket.write(JSON.stringify(latest) + "\n");
    },
    close() {
      socket.end();
    },
  };
}
