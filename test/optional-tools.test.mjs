import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { execFileWithOptionalTools, spawnWithOptionalTools } from "../src/server/optional-tools.ts";

async function result(child) {
  let stderr = "";
  child.stderr.on("data", (data) => (stderr += data));
  const [code] = await once(child, "close");
  return { code, stderr };
}

test("missing gh and git exit unsuccessfully without a spawn error", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-optional-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const command of ["gh", "git"]) {
    const child = spawnWithOptionalTools(command, ["--version"], {
      env: { PATH: directory },
    });
    let errors = 0;
    child.on("error", () => errors++);
    const response = await result(child);
    assert.equal(errors, 0);
    assert.equal(response.code, 127);
    assert.match(response.stderr, new RegExp(`${command} is unavailable`));
  }
});

test("a failing version probe remains an unsuccessful probe", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-optional-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const gh = path.join(directory, "gh");
  await fs.writeFile(gh, "#!/bin/sh\necho unavailable >&2\nexit 3\n", { mode: 0o755 });
  const response = await result(
    spawnWithOptionalTools("gh", ["--version"], { env: { PATH: directory } }),
  );
  assert.equal(response.code, 3);
  assert.match(response.stderr, /unavailable/);
});

test("execFile reports a missing optional command through its callback", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-optional-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const outcome = await new Promise((resolve) => {
    execFileWithOptionalTools("gh", ["--version"], { env: { PATH: directory } },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  assert.equal(outcome.error.code, 127);
  assert.equal(outcome.stdout, "");
  assert.match(outcome.stderr, /gh is unavailable/);
});

test("promisified execFile keeps Node's stdout and stderr contract", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-optional-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    promisify(execFileWithOptionalTools)("gh", ["--version"], { env: { PATH: directory } }),
    (error) => error.code === 127 && /gh is unavailable/.test(error.stderr),
  );
});
