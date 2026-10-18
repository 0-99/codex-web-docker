// Invoked through the executable wrapper prepared by prepare-container.mjs.
// Keep the image's own entrypoint, filesystem and dependencies in the test.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

assert.equal(process.env.CODEX_TEST_NETWORK_ISOLATED, "1");
const anchor = process.env.CODEX_TEST_NETWORK_CONTAINER;
const image = process.env.CODEX_TEST_IMAGE_REF;
assert.ok(anchor && image && process.env.CODEX_HOME);
const inspected = JSON.parse(
  execFileSync("docker", ["inspect", anchor], { encoding: "utf8" }),
)[0];
assert.equal(inspected.HostConfig.NetworkMode, "none");
assert.deepEqual(Object.keys(inspected.NetworkSettings.Networks), ["none"]);
const name = `codex-ci-cli-${randomUUID()}`;
const root = path.resolve(import.meta.dirname, "../..");
const child = spawn(
  "docker",
  [
    "run",
    "--rm",
    "--init",
    "--interactive",
    "--pull=never",
    "--name",
    name,
    "--network",
    `container:${anchor}`,
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--volume",
    `${root}:${root}`,
    "--workdir",
    process.cwd(),
    "--env",
    `CODEX_HOME=${process.env.CODEX_HOME}`,
    "--env",
    `HOME=${process.env.CODEX_HOME}`,
    "--env",
    "RUST_LOG=warn",
    image,
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  // Killing docker's client alone can leave the app-server running. Stop its
  // actual container so restart assertions exercise a new server process.
  const stopper = spawn("docker", ["stop", "--time", "1", name], {
    stdio: "ignore",
  });
  stopper.on("error", () => child.kill("SIGTERM"));
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("close", (code) => {
  try {
    execFileSync("docker", ["rm", "--force", name], {
      stdio: "ignore",
      timeout: 5000,
    });
  } catch {}
  process.exitCode = code ?? 1;
});
