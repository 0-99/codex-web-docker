import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const main = readFileSync("scratch/asar/.vite/build/main-CqEoQDOU.js", "utf8");

function desktopOverrides(disabled) {
  const context = {
    process: {
      env: { CODEX_WEB_DISABLE_INTERNAL_APP_MCP: disabled ? "1" : "0" },
    },
    c: { yt: () => false },
    r: { Ti: () => false },
    $c: async () => ({ command: "desktop-tools", cwd: "/desktop" }),
  };
  function extract(start, end) {
    const from = main.indexOf(start);
    const to = main.indexOf(end, from);
    assert.ok(from >= 0 && to > from, "locate pinned Desktop override factory");
    return vm.runInNewContext(`(${main.slice(from, to).trim()})`, context);
  }
  return {
    plugin: extract("async function Yc(e) {", "async function Xc(e) {"),
    legacy: extract("async function Xc(e) {", "async function Zc("),
  };
}

test("external app-server omits Desktop tools while retaining auth and other startup overrides", async () => {
  const { plugin: Yc, legacy } = desktopOverrides(true);
  const e = {
    hostConfig: { kind: "local" },
    secretAuthStorageConfigOverrides: Promise.resolve([
      "auth-storage=retained",
    ]),
  };
  const from = main.indexOf(
    "    getConfigOverrides: async () => [\n      ...g.W",
  );
  const to = main.indexOf("\n    ],", from);
  assert.ok(from >= 0 && to > from, "locate transport startup overrides");
  const factory = vm.runInNewContext(
    `({${main.slice(from, to + "\n    ]".length)}}).getConfigOverrides`,
    {
      e,
      g: { W: () => ["workspace-policy=retained"] },
      Yc,
      yYe: () => "review-plugin=retained",
    },
  );
  assert.deepEqual(Array.from(await factory()), [
    "workspace-policy=retained",
    "auth-storage=retained",
    "review-plugin=retained",
  ]);
  assert.deepEqual(Object.entries(await legacy(e)), []);
});

test("native opt-in retains both upstream plugin and legacy tool overrides", async () => {
  const { plugin, legacy } = desktopOverrides(false);
  const local = { hostConfig: { kind: "local" } };
  assert.deepEqual(Array.from(await plugin(local)), [
    "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true",
  ]);
  assert.deepEqual(Object.fromEntries(Object.entries(await legacy(local))), {
    "mcp_servers.codex_app.command": "desktop-tools",
    "mcp_servers.codex_app.cwd": "/desktop",
    "mcp_servers.codex_app.enabled": true,
  });
  assert.deepEqual(
    Array.from(await plugin({ hostConfig: { kind: "remote" } })),
    [],
  );
});
