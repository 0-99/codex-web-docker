// Test-only relay. It is started inside the CLI container in the test's
// isolated network namespace; the local bridge harness forwards to this port.
import net from "node:net";

net
  .createServer((client) => {
    const upstream = net.connect("/run/codex/app-server.sock");
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  })
  .listen(45823, "0.0.0.0");
