import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
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
  optInEnv,
} from "../support/workspace-routing.mjs";

test(
  "current CLI through the relay: ChatGPT account, native routing and turn",
  { timeout: 120000 },
  async (t) => {
    const binary = process.env.CODEX_TEST_CLI_PATH;
    assert.ok(binary);
    // The actual-image wrapper requires an isolated CODEX_HOME even for a
    // version probe. Never let it fall back to a runner's existing profile.
    await fs.mkdir("scratch", { recursive: true });
    const versionHome = await fs.mkdtemp(
      path.resolve("scratch/routing-version-"),
    );
    t.after(() => fs.rm(versionHome, { recursive: true, force: true }));
    const version = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: versionHome },
      timeout: 30000,
    }).trim();
    const { supported } = JSON.parse(
      await fs.readFile(new URL("./images.json", import.meta.url), "utf8"),
    );
    assert.equal(version, `codex-cli ${supported.expectedCliVersion}`);
    const accessToken = token();
    const backendOrigin = "https://workspace.example.invalid";
    const server = await appServerFixture(t, {
      accountRouting: {
        id: "ci-account",
        workspace_backend_origin: backendOrigin,
        account_routing_override: "us",
      },
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
      ["docker/codex-app-server-proxy.mjs", "app-server"],
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
    try {
      await rpc.call("initialize", init.params);
    } catch (error) {
      // All credentials are synthetic and networking is isolated. Still redact
      // the token if upstream ever includes it in a diagnostic during startup.
      const details = `${proxy.log()}\n${server.log()}`.replaceAll(
        accessToken,
        "[redacted]",
      );
      throw new Error(`Routing fixture initialization failed: ${details}`, {
        cause: error,
      });
    }
    rpc.notify("initialized");
    const account = await rpc.call("account/read", { refreshToken: false });
    const requirements = await rpc.call("configRequirements/read", {});
    assert.equal(account.account.type, "chatgpt");
    assert.deepEqual(account.workspaceRouting, {
      chatgptAccountId: "ci-account",
      backendOrigin,
      accountRoutingOverride: "us",
    });
    assert.equal(requirements.requirements, null);
    const client = {
      appServerVersion: supported.expectedCliVersion,
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
    // Native routing must work with either opt-in setting, without invoking
    // the historical missing-capability verifier.
    for (const env of [{}, optInEnv]) {
      const auth = await routingClient(client, env).get(false);
      const headers = {};
      assert.equal(
        routeUrl(
          new URL("/backend-api/settings/user", accountUrl).href,
          headers,
          auth,
        ),
        `${backendOrigin}/backend-api/settings/user`,
      );
      assert.equal(headers["X-OpenAI-Account-Routing-Override"], "us");
    }
    assert.equal(discoveries, 0);
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
