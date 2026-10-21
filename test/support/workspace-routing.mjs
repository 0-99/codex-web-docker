import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { verifyLegacyWorkspaceRoute } from "../../src/server/workspace-routing.js";

const require = createRequire(import.meta.url);
const root = "../../scratch/asar/.vite/build/";
const bundle = readFileSync(
  new URL(root + "src-BJv5Mk7n.js", import.meta.url),
  "utf8",
);
const bootstrap = readFileSync(
  new URL(root + "bootstrap-CooIJpZm.js", import.meta.url),
  "utf8",
);
const schemas = require(root + "zod-ClKgiFhi.js");
const versions = require(root + "src-CP7XXlpZ.js");
function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `locate pinned Desktop ${start}`);
  return source.slice(from, to);
}
const context = vm.createContext({
  t: schemas,
  n: versions,
  Buffer,
  URL,
  AbortController,
  DOMException,
  U: () => {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  },
  ue: async (promise, signal) => {
    const value = await promise;
    signal.throwIfAborted();
    return value;
  },
});
vm.runInContext(between(bundle, "var Hn =", "function Jn("), context);
const Routing = vm.runInContext(
  "let " + between(bundle, "TI = t.O({", "function AI(") + "; kI",
  context,
);
export const routeUrl = vm.runInNewContext(
  "(" + between(bootstrap, "function rn(e, t, n)", "function an(") + ")",
  { URL },
);
export const initializeRequest = vm.runInNewContext(
  "(" + between(bundle, "function CL(e, t)", "function wL(") + ")",
  {
    SL: "__codex_initialize__",
    bL: "form",
    n: { vn: "ci", yn: () => ({}), bn: [] },
  },
);

export function token(account = "ci-account", user = "ci-user", extra = {}) {
  const payload = {
    exp: Math.floor(Date.now() / 1000) + 86400,
    "https://api.openai.com/auth": {
      chatgpt_account_id: account,
      user_id: user,
      chatgpt_user_id: user,
      chatgpt_plan_type: "plus",
      ...extra,
    },
    email: "ci@example.invalid",
  };
  return (
    "ci." + Buffer.from(JSON.stringify(payload)).toString("base64url") + ".ci"
  );
}
export const account = () => ({
  account: { type: "chatgpt", email: "ci@example.invalid", planType: "plus" },
  requiresOpenaiAuth: true,
});
export const requirements = () => ({ requirements: null });
export const accounts = () => ({
  accounts: [
    {
      id: "ci-account",
      workspace_backend_origin: "NO_CONSTRAINT",
      account_routing_override: "NO_CONSTRAINT",
    },
  ],
});
export const accountUrl =
  "https://bootstrap.example.invalid/backend-api/wham/accounts/check";

export function fixture(overrides = {}) {
  const state = {
    account: account(),
    requirements: requirements(),
    token: token(),
    ...overrides,
  };
  const requests = [];
  const client = {
    appServerVersion: "0.155.1",
    options: {},
    getAuthToken: async () => state.token,
    sendAppServerExtensionRequest: async (method) =>
      method === "account/read" ? state.account : state.requirements,
  };
  client.options.verifyLegacyWorkspaceRouting = async ({ token, signal }) =>
    verifyLegacyWorkspaceRoute({
      token,
      signal,
      accountUrl,
      headers: {
        Authorization: `Bearer ${token}`,
        "ChatGPT-Account-ID": "ci-account",
      },
      fetch: async (url, init) => {
        requests.push({ url, init });
        return Response.json(accounts());
      },
      readState: async () => state,
    });
  return { state, client, requests, routing: new Routing(client, () => {}) };
}
export function routingClient(client) {
  return new Routing(client, () => {});
}

// Execute the actual main-bundle option and bootstrap builders, not a parallel
// test implementation of the wiring between discovery and the fork verifier.
export function wireVerifier(
  client,
  fetch,
  host = "local",
  transport = "stdio",
) {
  const boot = vm.createContext({
    process: { env: {} },
    URL,
    r: versions,
    i: { ii: vm.runInContext("Kn", context) },
    Xt: () => "codex-web-routing-test",
    Zt: () => "test",
  });
  vm.runInContext(
    between(bootstrap, "function $t(e)", "async function tn("),
    boot,
  );
  vm.runInContext(between(bootstrap, "function on(e, t,", "var fn ="), boot);
  const builders = vm.runInContext("({ dt: en, it: on })", boot);
  const main = readFileSync(
    new URL(root + "main-CqEoQDOU.js", import.meta.url),
    "utf8",
  );
  const source = between(
    main,
    "          verifyLegacyWorkspaceRouting:",
    "          buildFlavor: this.options.buildFlavor,",
  );
  const factory = vm.runInNewContext(
    "(function () { return ({" + source + "}).verifyLegacyWorkspaceRouting; })",
    {
      e: host,
      l: { h: "local" },
      d: { kind: transport },
      g: builders,
      s: {
        desktopOriginator: "codex_desktop",
        prodApiBaseUrl: new URL("/backend-api", accountUrl).href,
      },
      m: client,
      __codexWebVerifyLegacyWorkspaceRoute: verifyLegacyWorkspaceRoute,
    },
  );
  return factory.call({ options: { applicationNetwork: { fetch } } });
}
