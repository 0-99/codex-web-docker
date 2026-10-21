import assert from "node:assert/strict";
import test from "node:test";
import { verifyLegacyWorkspaceRoute } from "../src/server/workspace-routing.js";
import {
  fixture,
  account,
  requirements,
  token,
  accounts,
  accountUrl,
  routeUrl,
  initializeRequest,
  wireVerifier,
} from "./support/workspace-routing.mjs";

test("0.155.1 without workspaceRouting uses only a verified same-origin legacy route", async () => {
  const { routing, requests } = fixture();
  const auth = await routing.get(false);
  assert.equal(auth.routing.kind, "legacy");
  assert.equal(
    auth.routing.codexWebVerified.origin,
    new URL(accountUrl).origin,
  );
  const headers = { "X-OpenAI-Account-Routing-Override": "us" };
  const target = new URL("/backend-api/settings/user", accountUrl).href;
  assert.equal(routeUrl(target, headers, auth), target);
  assert.deepEqual(headers, {});
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.redirect, "error");
  assert.equal(requests[0].init.credentials, "omit");
  assert.throws(
    () => routeUrl("https://other.example.invalid/settings/user", {}, auth),
    /destination changed/,
  );
});

test("explicit null and malformed routes never fall back", async () => {
  for (const value of [null, {}, { chatgptAccountId: "wrong" }]) {
    const f = fixture({ account: { ...account(), workspaceRouting: value } });
    await assert.rejects(f.routing.get(false));
    assert.equal(f.requests.length, 0);
  }
});

test("native routing objects retain their destination and account binding", async () => {
  for (const id of ["ci-account", "wrong-account"]) {
    const workspaceRouting = {
      chatgptAccountId: id,
      backendOrigin: "https://workspace.example.invalid",
      accountRoutingOverride: "us",
    };
    const f = fixture({ account: { ...account(), workspaceRouting } });
    if (id !== "ci-account")
      await assert.rejects(f.routing.get(false), /does not match/);
    else {
      const auth = await f.routing.get(false);
      const headers = {};
      assert.equal(
        routeUrl("https://bootstrap.example.invalid/path?x=1", headers, auth),
        "https://workspace.example.invalid/path?x=1",
      );
      assert.equal(headers["X-OpenAI-Account-Routing-Override"], "us");
    }
    assert.equal(f.requests.length, 0);
  }
});

const policies = [
  { chatgptBaseUrl: "https://managed.example.invalid" },
  { enforceResidency: "us" },
  { application: { network: {} } },
  { application: { network: false } },
];
for (const policy of policies)
  test(`managed policy blocks compatibility: ${JSON.stringify(policy)}`, async () => {
    const f = fixture({ requirements: { requirements: policy } });
    await assert.rejects(
      f.routing.get(false),
      /Workspace routing is unavailable/,
    );
    assert.equal(f.requests.length, 0);
  });

test("FedRAMP, malformed claims and missing account/user fail closed", async () => {
  for (const value of [
    token("ci-account", "ci-user", { chatgpt_account_is_fedramp: true }),
    token("ci-account", "ci-user", { chatgpt_account_is_fedramp: "false" }),
    token("", "ci-user"),
    token("ci-account", ""),
    "invalid",
  ]) {
    const f = fixture({ token: value });
    await assert.rejects(f.routing.get(false));
    assert.equal(f.requests.length, 0);
  }
});

test("exception does not extend the version range or replace the older upstream path", async () => {
  for (const version of ["0.155.0", "0.155.2", "0.155.1-alpha.1", "0.156.0"]) {
    const f = fixture();
    f.client.appServerVersion = version;
    await assert.rejects(f.routing.get(false));
    assert.equal(f.requests.length, 0);
  }
  const f = fixture();
  f.client.appServerVersion = "0.154.0";
  assert.equal((await f.routing.get(false)).routing.kind, "legacy");
  assert.equal(f.requests.length, 0);
});

function probe(changes = {}) {
  const value = token();
  return {
    token: value,
    headers: {
      Authorization: `Bearer ${value}`,
      "ChatGPT-Account-ID": "ci-account",
    },
    signal: new AbortController().signal,
    accountUrl,
    fetch: async () => Response.json(accounts()),
    readState: async () => ({
      token: value,
      account: account(),
      requirements: requirements(),
    }),
    ...changes,
  };
}

test("missing, duplicate, mismatched and constrained backend discovery fails closed", async () => {
  const entry = accounts().accounts[0];
  for (const payload of [
    {},
    { accounts: [] },
    { accounts: { "ci-account": { account: { account_id: "ci-account" } } } },
    { accounts: [{ ...entry, id: "other-account" }] },
    { accounts: [entry, entry] },
    ...[
      undefined,
      null,
      "https://other.example.invalid",
      "http://bootstrap.example.invalid",
      "https://bootstrap.example.invalid/path",
    ].map((origin) => ({
      accounts: [{ ...entry, workspace_backend_origin: origin }],
    })),
    ...[undefined, null, "us", "us_cr", "unknown"].map((override) => ({
      accounts: [{ ...entry, account_routing_override: override }],
    })),
  ])
    await assert.rejects(
      verifyLegacyWorkspaceRoute(
        probe({ fetch: async () => Response.json(payload) }),
      ),
      /could not be verified/,
    );
  await verifyLegacyWorkspaceRoute(
    probe({
      fetch: async () =>
        Response.json({
          accounts: [
            { ...entry, workspace_backend_origin: new URL(accountUrl).origin },
          ],
        }),
    }),
  );
});

test("auth headers must identify the same selected workspace before discovery", async () => {
  for (const headers of [
    {},
    { Authorization: "Bearer other", "ChatGPT-Account-ID": "ci-account" },
    { Authorization: `Bearer ${token()}`, "ChatGPT-Account-ID": "other" },
  ]) {
    let sent = false;
    await assert.rejects(
      verifyLegacyWorkspaceRoute(
        probe({
          headers,
          fetch: async () => {
            sent = true;
            return Response.json(accounts());
          },
        }),
      ),
    );
    assert.equal(sent, false);
  }
});

test("discovery failures, invalid responses, redirects and cancellation never grant access", async () => {
  for (const fetch of [
    async () => {
      throw Error("offline");
    },
    async () => new Response("", { status: 403 }),
    async () => new Response("not json"),
    async () => ({ ok: true, redirected: true }),
    async () => ({ ok: true, url: "https://other.example.invalid" }),
  ])
    await assert.rejects(verifyLegacyWorkspaceRoute(probe({ fetch })));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    verifyLegacyWorkspaceRoute(probe({ signal: controller.signal })),
  );
  for (const url of [
    "http://bootstrap.example.invalid",
    "https://user@bootstrap.example.invalid",
    accountUrl + "?override=1",
  ])
    await assert.rejects(
      verifyLegacyWorkspaceRoute(probe({ accountUrl: url })),
    );
});

test("policy, account and explicit-routing changes during discovery invalidate the proof", async () => {
  for (const change of [
    { token: token("other-account") },
    { token: token("ci-account", "other-user") },
    { account: { ...account(), workspaceRouting: null } },
    { account: { ...account(), workspaceRouting: {} } },
    ...policies.map((policy) => ({ requirements: { requirements: policy } })),
  ])
    await assert.rejects(
      verifyLegacyWorkspaceRoute(
        probe({
          readState: async () => ({
            token: token(),
            account: account(),
            requirements: requirements(),
            ...change,
          }),
        }),
      ),
    );
});

test("cached proof cannot be reused for a new user or account", async () => {
  for (const value of [
    token("other-account"),
    token("ci-account", "other-user"),
  ]) {
    const f = fixture();
    await f.routing.get(false);
    f.state.token = value;
    await assert.rejects(f.routing.get(false), /does not match/);
  }
});

test("Desktop initialize already enables experimentalApi without routing emulation", () => {
  const message = initializeRequest({
    hostId: "local",
    clientInfo: { name: "codex_web_ci", version: "1" },
    isMcpAppsDilEnabled: () => false,
    supportsOpenAIFormElicitation: false,
    supportsAttestationRequests: () => false,
  });
  assert.equal(message.params.capabilities.experimentalApi, true);
  assert.equal(message.params.capabilities.explicitGatewayOauth, true);
});

test("main bundle wires Desktop URL/auth builders and policy transport to the verifier", async () => {
  const f = fixture();
  let calls = 0;
  f.client.options.verifyLegacyWorkspaceRouting = wireVerifier(
    f.client,
    async (url, init) => {
      calls++;
      assert.equal(url, accountUrl);
      assert.equal(
        new Headers(init.headers).get("chatgpt-account-id"),
        "ci-account",
      );
      return Response.json(accounts());
    },
  );
  assert.equal((await f.routing.get(false)).routing.kind, "legacy");
  assert.equal(calls, 1);
  for (const [host, transport] of [
    ["remote", "stdio"],
    ["local", "websocket"],
  ]) {
    const other = fixture();
    other.client.options.verifyLegacyWorkspaceRouting = wireVerifier(
      other.client,
      async () => {
        throw Error("must not send");
      },
      host,
      transport,
    );
    await assert.rejects(other.routing.get(false), /requires the local relay/);
  }
  const blocked = fixture();
  blocked.client.options.verifyLegacyWorkspaceRouting = wireVerifier(
    blocked.client,
    async () => {
      throw Error("network policy denied");
    },
  );
  await assert.rejects(blocked.routing.get(false), /network policy denied/);
});
