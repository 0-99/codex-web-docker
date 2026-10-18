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
let socketInit;
if (selected === "supported") {
  const compose = JSON.parse(
    docker([
      "compose",
      "--file",
      "examples/docker-compose.yml",
      "--profile",
      "app-server",
      "config",
      "--format",
      "json",
    ]),
  );
  assert.equal(
    compose.services["codex-app-server"].image,
    image,
    "Example Compose must use the supported image from images.json",
  );
  socketInit = compose.services["codex-socket-init"];
  assert.equal(socketInit.image, image);
  assert.deepEqual(compose.services["codex-app-server"].command, [
    "app-server",
    "--listen",
    "unix:///run/codex/app-server.sock",
  ]);
}
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
if (socketInit) {
  const volume = `codex-ci-socket-${process.pid}`;
  docker(["volume", "create", volume]);
  try {
    docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      socketInit.user,
      "--volume",
      `${volume}:/run/codex`,
      "--entrypoint",
      socketInit.entrypoint[0],
      digest,
      ...socketInit.entrypoint.slice(1),
      ...socketInit.command,
    ]);
    docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--volume",
      `${volume}:/run/codex`,
      "--entrypoint",
      "/bin/sh",
      digest,
      "-ec",
      'test "$(id -u)" = 1000 && test "$(stat -c %a /run/codex)" = 700 && test -w /run/codex',
    ]);
    console.log(
      "Compose socket initialization verified with the image's default UID 1000",
    );
  } finally {
    docker(["volume", "rm", volume]);
  }
}

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
