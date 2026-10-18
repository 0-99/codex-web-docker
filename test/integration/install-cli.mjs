import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

// Only public, pinned packages are downloaded here. Test data is created later,
// inside a network namespace with loopback as its only interface.
let source = await fs.readFile("nix/codex/default.nix", "utf8");
const baseline = process.argv[2] === "baseline";
if (baseline) {
  const current = source.match(/version = "([^"]+)"/)?.[1];
  const history = execFileSync(
    "git",
    ["log", "--first-parent", "--format=%H", "--", "nix/codex/default.nix"],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n");
  let previous;
  for (const revision of history) {
    const candidate = execFileSync(
      "git",
      ["show", `${revision}:nix/codex/default.nix`],
      { encoding: "utf8" },
    );
    const version = candidate.match(/version = "([^"]+)"/)?.[1];
    if (version && version !== current) {
      previous = candidate;
      break;
    }
  }
  assert.ok(
    previous,
    "Checkout full history to locate the previous distinct CLI pin",
  );
  source = previous;
}
const version = source.match(/version = "([^"]+)"/)?.[1];
const hash = source.match(
  /x86_64-linux = \{[\s\S]*?hash = "sha256-([^"]+)"/,
)?.[1];
assert.ok(version && hash, "locate the pinned Linux CLI version and checksum");
const directory = path.resolve("scratch/integration-cli", version);
await fs.mkdir(directory, { recursive: true });
const response = await fetch(
  `https://registry.npmjs.org/@openai/codex/-/codex-${version}-linux-x64.tgz`,
);
assert.ok(response.ok, `CLI download: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
assert.equal(
  createHash("sha256").update(bytes).digest("base64"),
  hash,
  "CLI package checksum",
);
const archive = path.join(directory, "cli.tgz");
await fs.writeFile(archive, bytes);
execFileSync("tar", ["-xzf", archive, "-C", directory]);
const binary = path.join(
  directory,
  "package/vendor/x86_64-unknown-linux-musl/bin/codex",
);
await fs.access(binary);
console.log(execFileSync(binary, ["--version"], { encoding: "utf8" }).trim());
if (process.env.GITHUB_ENV)
  await fs.appendFile(
    process.env.GITHUB_ENV,
    `CODEX_TEST_CLI_PATH=${binary}\n`,
  );
else console.log(`CODEX_TEST_CLI_PATH=${binary}`);
