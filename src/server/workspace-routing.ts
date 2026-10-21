type DiscoveryState = {
  account: unknown;
  requirements: unknown;
  token: string | null;
};

type LegacyRouteProbe = {
  accountUrl: string;
  token: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  readState: () => Promise<DiscoveryState>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function denied(): never {
  // Keep credentials, account IDs and backend payloads out of error logs.
  throw new Error("CLI 0.155.1 legacy workspace route could not be verified");
}

function principal(token: string) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    const auth = payload["https://api.openai.com/auth"];
    const accountId = auth?.chatgpt_account_id;
    const userId = auth?.user_id ?? auth?.chatgpt_user_id;
    if (
      typeof accountId !== "string" ||
      !accountId ||
      typeof userId !== "string" ||
      !userId ||
      !Number.isFinite(payload.exp) ||
      payload.exp * 1000 <= Date.now() ||
      (auth.chatgpt_account_is_fedramp != null &&
        auth.chatgpt_account_is_fedramp !== false)
    )
      denied();
    return { accountId, userId };
  } catch {
    return denied();
  }
}

function unconstrained(value: unknown): boolean {
  return (
    record(value) &&
    (value.requirements === null ||
      (record(value.requirements) &&
        value.requirements.chatgptBaseUrl == null &&
        value.requirements.enforceResidency == null &&
        (value.requirements.application == null ||
          (record(value.requirements.application) &&
            value.requirements.application.network == null))))
  );
}

function missingRouting(value: unknown): boolean {
  return (
    record(value) &&
    record(value.account) &&
    value.account.type === "chatgpt" &&
    !Object.hasOwn(value, "workspaceRouting")
  );
}

/**
 * The 0.155.1 protocol predates workspaceRouting. Its Desktop legacy branch
 * preserves the configured request URL; it does NOT discover a destination.
 * Only authorize that branch after the authenticated accounts endpoint explicitly
 * confirms that the selected workspace permits this very origin without a
 * routing override. Never manufacture an account/read workspaceRouting value.
 *
 * This mirrors OpenAI's accounts-check routing contract, but supports only the
 * subset representable by the unchanged legacy path. Other origins/overrides,
 * old map responses without routing metadata, and discovery failures stay shut.
 */
export async function verifyLegacyWorkspaceRoute(
  probe: LegacyRouteProbe,
): Promise<{ origin: string; accountId: string; userId: string }> {
  const owner = principal(probe.token);
  const headers = new Headers(probe.headers);
  if (
    headers.get("authorization") !== `Bearer ${probe.token}` ||
    headers.get("chatgpt-account-id") !== owner.accountId
  )
    denied();
  const url = new URL(probe.accountUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    denied();
  const signal = AbortSignal.any([probe.signal, AbortSignal.timeout(10000)]);
  signal.throwIfAborted();
  const response = await probe.fetch(url.href, {
    method: "GET",
    headers: probe.headers,
    // A redirect cannot attest to the original origin. Do not send cookies or
    // retry using a different account if discovery fails.
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    signal,
  });
  if (
    !response.ok ||
    response.redirected ||
    (response.url && response.url !== url.href)
  )
    denied();
  const data: unknown = await response.json();
  signal.throwIfAborted();
  if (!record(data) || !Array.isArray(data.accounts)) denied();
  const matches = data.accounts.filter(
    (entry: unknown) => record(entry) && entry.id === owner.accountId,
  );
  if (matches.length !== 1) denied();
  const workspace = matches[0];
  if (workspace.account_routing_override !== "NO_CONSTRAINT") denied();
  const backend = workspace.workspace_backend_origin;
  // NO_CONSTRAINT means the configured bootstrap origin is allowed (as in
  // OpenAI's resolve_routing). An explicit origin must match it exactly.
  if (backend !== "NO_CONSTRAINT" && backend !== url.origin) denied();

  // Discovery is asynchronous: an account switch or new managed policy must
  // not turn a successful response for the old owner into permission for another.
  const current = await probe.readState();
  signal.throwIfAborted();
  if (
    !current.token ||
    !missingRouting(current.account) ||
    !unconstrained(current.requirements)
  )
    denied();
  const selected = principal(current.token);
  if (
    selected.accountId !== owner.accountId ||
    selected.userId !== owner.userId
  )
    denied();
  return { origin: url.origin, ...owner };
}

declare global {
  var __codexWebVerifyLegacyWorkspaceRoute: typeof verifyLegacyWorkspaceRoute;
}
