import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const selected = process.argv[2];
const config = JSON.parse(
  await fs.readFile(new URL("./images.json", import.meta.url), "utf8"),
);
assert.ok(selected === "supported" || selected === "candidate");
const { image, expectedCliVersion } = config[selected];
function docker(args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
}
const compose = JSON.parse(
  docker([
    "compose",
    "--file",
    "examples/docker-compose.yml",
    "config",
    "--format",
    "json",
  ]),
);
const cli = compose.services["codex-cli"];
if (selected === "supported") {
  assert.equal(
    cli.image,
    image,
    "Example Compose must use the supported image from images.json",
  );
}
assert.deepEqual(cli.command, [
  "app-server",
  "--listen",
  "unix:///run/codex/app-server.sock",
]);
// Validate the actual example mounts before using them in the cross-container probe.
for (const service of [cli, compose.services["codex-web"]]) {
  for (const [source, target] of [
    ["codex_socket", "/run/codex"],
    ["codex_daemon", "/tmp/codex-daemon-1000"],
  ]) {
    assert.ok(
      service.volumes.some(
        (mount) =>
          mount.type === "volume" &&
          mount.source === source &&
          mount.target === target,
      ),
      `Both services must share ${source} at ${target}`,
    );
  }
}
const security = cli.security_opt;
assert.deepEqual(security, ["seccomp=unconfined", "systempaths=unconfined"]);
const securityArgs = security.flatMap((option) => ["--security-opt", option]);
docker(["pull", image]);
const inspected = JSON.parse(docker(["image", "inspect", image]))[0];
const digest = inspected.RepoDigests.find((ref) =>
  ref.startsWith("ghcr.io/icoretech/codex-docker@sha256:"),
);
assert.ok(digest, "Record an immutable pulled image reference");
const version = docker([
  "run",
  "--rm",
  "--network",
  "none",
  digest,
  "--version",
]);
if (expectedCliVersion)
  assert.equal(version, `codex-cli ${expectedCliVersion}`);
console.log(`${selected}: ${image}\nDigest: ${digest}\n${version}`);
// Exercise the example's fresh volumes with the image's default user. These
// probes have no network, account credentials or model requests.
if (selected === "supported") {
  const socket = `codex-ci-socket-${process.pid}`;
  const workspace = `codex-ci-workspace-${process.pid}`;
  const daemon = `codex-ci-daemon-${process.pid}`;
  const probe = `codex-ci-cli-volume-${process.pid}`;
  for (const [name, volume] of [
    [socket, compose.volumes.codex_socket],
    [daemon, compose.volumes.codex_daemon],
  ]) {
    docker([
      "volume",
      "create",
      "--driver",
      volume.driver,
      ...Object.entries(volume.driver_opts).flatMap(([key, value]) => [
        "--opt",
        `${key}=${value}`,
      ]),
      name,
    ]);
  }
  docker(["volume", "create", workspace]);
  try {
    const mounts = [
      "--volume",
      `${socket}:/run/codex`,
      "--volume",
      `${daemon}:/tmp/codex-daemon-1000`,
      "--volume",
      `${workspace}:/workspace`,
      "--volume",
      `${workspace}:/home/node/Documents/Codex`,
    ];
    docker([
      "run",
      "--rm",
      "--network",
      "none",
      ...mounts,
      "--entrypoint",
      "/bin/sh",
      digest,
      "-ec",
      'test "$(id -u)" = 1000 && test "$(stat -c %a /run/codex)" = 700 && test -w /run/codex && test "$(stat -c %a /tmp/codex-daemon-1000)" = 700 && test -w /tmp/codex-daemon-1000 && echo workspace-probe > /workspace/.compose-probe && grep -qx workspace-probe /home/node/Documents/Codex/.compose-probe',
    ]);
    docker([
      "run",
      "--detach",
      "--name",
      probe,
      "--network",
      "none",
      ...securityArgs,
      ...mounts,
      digest,
      ...cli.command,
    ]);
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        docker(["exec", probe, "/bin/sh", "-ec", cli.healthcheck.test[1]]);
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    assert.ok(
      ready,
      "Compose app-server must create its socket on the fresh tmpfs volume",
    );
    // Check the alias from a separate container with the web service's mounts.
    // Merely checking inside the CLI container misses dangling cross-container links.
    docker([
      "run",
      "--rm",
      "--network",
      "none",
      ...mounts,
      "--entrypoint",
      "/bin/sh",
      digest,
      "-ec",
      'test -L /run/codex/app-server.sock && test -S /run/codex/app-server.sock && test -S "$(readlink /run/codex/app-server.sock)"',
    ]);
    console.log(
      "Compose default UID 1000, tmpfs socket, healthcheck and both workspace paths verified",
    );
  } catch (error) {
    try {
      console.error(docker(["logs", probe]));
    } catch {}
    throw error;
  } finally {
    try {
      docker(["rm", "--force", probe]);
    } catch {}
    docker(["volume", "rm", socket, daemon, workspace]);
  }
}

// The wrapper runs as the host test user; the CLI requires exact owner-only mode.
await fs.mkdir(`/tmp/codex-daemon-${process.getuid()}`, {
  recursive: true,
  mode: 0o700,
});
assert.equal(
  (await fs.stat(`/tmp/codex-daemon-${process.getuid()}`)).mode & 0o777,
  0o700,
);

const anchor = `codex-ci-network-${selected}`;
docker([
  "run",
  "--detach",
  "--name",
  anchor,
  "--network",
  "none",
  "--entrypoint",
  "/bin/sh",
  digest,
  "-c",
  "while :; do sleep 3600; done",
]);
const pid = docker(["inspect", "--format", "{{.State.Pid}}", anchor]);
await fs.mkdir("scratch", { recursive: true });
const wrapper = path.resolve(`scratch/container-cli-${selected}.mjs`);
await fs.writeFile(
  wrapper,
  `#!/usr/bin/env node\nimport ${JSON.stringify(new URL("./container-cli.mjs", import.meta.url).href)};\n`,
  { mode: 0o755 },
);
const env = {
  CODEX_TEST_CLI_PATH: wrapper,
  CODEX_TEST_IMAGE_REF: digest,
  CODEX_TEST_NETWORK_CONTAINER: anchor,
  CODEX_TEST_NETWORK_PID: pid,
  CODEX_TEST_CLI_SECURITY_OPTS: JSON.stringify(security),
};
assert.ok(
  process.env.GITHUB_ENV,
  "Prepare container runtimes inside GitHub Actions",
);
await fs.appendFile(
  process.env.GITHUB_ENV,
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}\n`)
    .join(""),
);
if (process.env.GITHUB_STEP_SUMMARY)
  await fs.appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `### ${selected} container\n\n- Requested: \`${image}\`\n- Executed: \`${digest}\`\n- Version: \`${version}\`\n\n${selected === "candidate" ? "Advisory upgrade probe only; this does not change the supported image.\n" : "Required compatibility baseline.\n"}`,
  );
