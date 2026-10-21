import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  appServerFixture,
  childProcess,
  rpcStream,
  until,
} from "./support.mjs";
import {
  routingClient,
  token,
  accounts,
  accountUrl,
  initializeRequest,
  routeUrl,
  wireVerifier,
} from "../support/workspace-routing.mjs";

test(
  "real CLI 0.155.1 through the relay and v0.4.2 Desktop routing: ChatGPT account, verified route and turn",
  { timeout: 120000 },
  async (t) => {
    const binary = process.env.CODEX_TEST_CLI_PATH;
    assert.ok(binary);
    const version = execFileSync(binary, ["--version"], {
      encoding: "utf8",
    }).trim();
    if (version !== "codex-cli 0.155.1") {
      t.skip(
        "The compatibility exception applies only to stable 0.155.1; the supported-image job exercises it",
      );
      return;
    }
    const accessToken = token();
    const server = await appServerFixture(t, {
      chatgptAuth: {
        auth_mode: "chatgpt",
        tokens: {
          id_token: accessToken,
          access_token: accessToken,
          refresh_token: "ci-unused-refresh",
          account_id: "ci-account",
        },
        last_refresh: new Date().toISOString(),
      },
    });
    const proxy = childProcess(
      process.execPath,
      ["docker/codex-app-server-proxy.mjs"],
      {
        CODEX_APP_SERVER_URL: server.endpoint,
        CODEX_HOME: server.codexHome,
      },
    );
    server.cleanup(() => proxy.stop());
    const rpc = rpcStream(proxy.child);
    const init = initializeRequest({
      hostId: "local",
      clientInfo: { name: "codex_web_ci", version: "1" },
      isMcpAppsDilEnabled: () => false,
      supportsOpenAIFormElicitation: false,
      supportsAttestationRequests: () => false,
    });
    await rpc.call("initialize", init.params);
    rpc.notify("initialized");
    const account = await rpc.call("account/read", { refreshToken: false });
    const requirements = await rpc.call("configRequirements/read", {});
    assert.equal(account.account.type, "chatgpt");
    assert.equal(Object.hasOwn(account, "workspaceRouting"), false);
    assert.equal(requirements.requirements, null);
    const client = {
      appServerVersion: "0.155.1",
      getAuthToken: async () =>
        (
          await rpc.call("getAuthStatus", {
            includeToken: true,
            refreshToken: false,
          })
        ).authToken,
      sendAppServerExtensionRequest: (method, params) =>
        rpc.call(method, params),
      options: {},
    };
    let discoveries = 0;
    // Execute the actual main-bundle callback with the real CLI-backed client.
    // Only the HTTPS accounts response is simulated; it is not a live entitlement.
    client.options.verifyLegacyWorkspaceRouting = wireVerifier(
      client,
      async () => {
        discoveries++;
        return Response.json(accounts());
      },
    );
    const routing = routingClient(client);
    const auth = await routing.get(false);
    assert.equal(auth.routing.kind, "legacy");
    assert.equal(discoveries, 1);
    assert.equal(
      routeUrl(
        new URL("/backend-api/settings/user", accountUrl).href,
        {},
        auth,
      ),
      new URL("/backend-api/settings/user", accountUrl).href,
    );
    const started = await rpc.call("thread/start", {
      cwd: server.workspace,
      model: "ci-model",
      modelProvider: "ci",
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const turn = await rpc.call("turn/start", {
      threadId: started.thread.id,
      input: [
        {
          type: "text",
          text: "Verify routing compatibility.",
          text_elements: [],
        },
      ],
    });
    await until(
      () =>
        rpc.messages.some(
          (message) =>
            message.method === "turn/completed" &&
            message.params.turn.id === turn.turn.id,
        ),
      "compatibility turn completion",
      30000,
    );
    assert.ok(server.model.requests.length > 0);
    // The relay must not manufacture workspaceRouting or alter managed requirements.
    assert.deepEqual(
      await rpc.call("account/read", { refreshToken: false }),
      account,
    );
    assert.deepEqual(
      await rpc.call("configRequirements/read", {}),
      requirements,
    );
  },
);
