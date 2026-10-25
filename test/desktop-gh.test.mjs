import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync("scratch/asar/.vite/build/src-BJv5Mk7n.js", "utf8");
const start = source.indexOf("async function ZQ(e, t) {");
const end = source.indexOf("function QQ(", start);
assert.ok(start >= 0 && end > start, "locate the pinned Desktop GitHub helper");
const runGitHub = vm.runInNewContext(`(${source.slice(start, end)})`, {
  JQ: {},
  c: { s: async (child) => child },
  n: { Bi: () => false, Ii: () => null },
  o: { Bt: (args) => args.join(" "), bt: (environment) => environment },
  process,
});

function client(spawn) {
  return { appServerClient: { id: "local", hostConfig: { kind: "local" }, spawn } };
}

test("pinned Desktop classifies missing gh and keeps failing versions unsuccessful", async () => {
  const missing = await runGitHub(["--version"], client(async () => ({
    stdout: "",
    stderr: "gh: command not found (unavailable in the Codex Web runtime)",
    code: 127,
    signal: null,
  })));
  assert.equal(missing.success, false);
  assert.equal(missing.isExecutableMissing, true);
  const failed = await runGitHub(["--version"], client(async () => ({
    stdout: "",
    stderr: "version probe failed",
    code: 3,
    signal: null,
  })));
  assert.equal(failed.success, false);
  assert.equal(failed.isExecutableMissing, false);
  const spawnFailure = await runGitHub(["--version"], client(async () => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  }));
  assert.equal(spawnFailure.success, false);
  assert.equal(spawnFailure.isExecutableMissing, true);
});
