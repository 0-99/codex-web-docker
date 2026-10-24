import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { installModuleAliasHook } from "../src/server/module.js";

test("Desktop child_process imports receive the optional-tool boundary", async () => {
  const originalLoad = Module._load;
  try {
    installModuleAliasHook();
    const desktopParent = {
      filename: path.resolve("scratch/asar/.vite/build/main.js"),
    };
    const nativeParent = { filename: path.resolve("test/native.js") };
    const desktop = Module._load("node:child_process", desktopParent, false);
    const native = Module._load("node:child_process", nativeParent, false);
    assert.notEqual(desktop.spawn, native.spawn);
    const child = desktop.spawn("gh", ["--version"], { env: { PATH: "/nonexistent" } });
    let spawnErrors = 0;
    child.on("error", () => spawnErrors++);
    const [exitCode] = await once(child, "close");
    assert.equal(exitCode, 127);
    assert.equal(spawnErrors, 0);
    const [nextExitCode] = await once(desktop.spawn("/bin/true"), "close");
    assert.equal(nextExitCode, 0, "the same process can still use child_process");
  } finally {
    Module._load = originalLoad;
  }
});
