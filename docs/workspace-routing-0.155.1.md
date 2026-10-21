# Workspace routing compatibility with stable CLI 0.155.1

## Regression and protocol evidence

Web v0.3.5 pins Desktop `26.901.41123`; Web v0.4.2 pins Desktop
`26.1007.30912`. The reported installation keeps the same
`ghcr.io/icoretech/codex-docker:0.155.1` image ID across the Web-only rollback.
The older Web starts chats and turns; the newer Web reports routing error 432.
This rollback and the real account/read observations are user-provided evidence,
not a live test performed by this PR.

In the older Desktop main bundle (`main-C5K7o1Hr.js`),
`performDesktopFetch` obtains the app-server token, applies the authenticated
account header and sends the already-resolved URL. It checks an expected
principal, but does not discover or attest a workspace backend. Its separate
`QV` helper reads `/accounts/check/v4-2023-04-27` for settings webview cookies;
that is not a route discovery step for ordinary API requests.

The newer Desktop uses `kI.discover` in `src-BJv5Mk7n.js`:

- A valid `workspaceRouting` object supplies the backend and routing override.
  `kI.get` verifies its account against the access token.
- Explicit `null` is not a legacy capability indication.
- An omitted field permits legacy routing only for versions from `0.141.0`
  up to, excluding, `0.155.0-alpha.5`, with no managed backend, residency or
  application-network requirement and no FedRAMP claim.
- Stable `0.155.1` compares above that cutoff but still omits the protocol field.
  Semver comparison is not evidence that a particular binary has that capability.
  In this case discovery throws before the requested account/settings HTTP fetch.
- `bootstrap-CooIJpZm.js:rn` leaves the already-resolved URL unchanged for legacy
  routing. Simply accepting that discriminator would not verify the destination.

The actual `0.155.1` binary's `app-server generate-json-schema --experimental`
confirms that `GetAccountResponse` has `account` and `requiresOpenaiAuth`, but no
`workspaceRouting`. Desktop's `CL` initialize factory already sets
`experimentalApi: true`; the relay forwards this request and account/policy RPCs
unchanged. The regression is not fixed by adding another initialize capability.

Primary OpenAI source for these contracts:

- [0.155.1 account protocol](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/app-server-protocol/src/protocol/v2/account.rs)
- [Newer account-owned discovery and resolve_routing](https://github.com/openai/codex/blob/rust-v0.162.0-alpha.17.2/codex-rs/app-server/src/request_processors/account_processor/workspace_routing.rs)
- [Accounts response types](https://github.com/openai/codex/blob/rust-v0.162.0-alpha.17.2/codex-rs/backend-client/src/types.rs)
- [Bootstrap accounts-check endpoint](https://github.com/openai/codex/blob/rust-v0.162.0-alpha.17.2/codex-rs/backend-client/src/client.rs)

The newer source documents the routing proof, not a CLI upgrade in this change.
Its ChatGPT bootstrap is `/wham/accounts/check`, distinct from the older settings
endpoint. A list entry identifies the workspace with `id` and supplies
`workspace_backend_origin` and `account_routing_override`. The older map form
normalizes to missing routing metadata and cannot authorize this exception.

## Narrow compatibility rule

The patch adds a separate branch for exact version `0.155.1` and a genuinely
absent `workspaceRouting` property. It preserves the existing upstream version
range and native object/null handling. All existing backend, residency,
application-network and FedRAMP guards remain prerequisites.

The local stdio connection supplies Desktop's existing configured URL builder,
auth header builder and application-network transport to the fork-owned
`src/server/workspace-routing.ts`. No fixed backend origin is introduced, and no
app-server response is changed or fabricated.

Before authorizing legacy routing, the verifier:

1. Requires an unexpired token with a selected account and user, matching the
   actual authorization and account headers. FedRAMP and malformed claims fail.
2. Queries Desktop's configured bootstrap accounts endpoint through the existing
   network policy, using HTTPS without redirects, cookies or a credential retry.
3. Requires exactly one entry for the selected account. Its backend must be
   `NO_CONSTRAINT` (which OpenAI resolves to the configured bootstrap origin) or
   exactly that origin. Its routing override must be `NO_CONSTRAINT`.
4. Re-reads account, requirements and token after discovery. A supplied routing
   field, account/user switch or new managed policy invalidates the proof.
5. Binds the cached proof to account and user. The legacy URL adapter additionally
   rejects any destination outside the verified origin.

An explicit different backend or `us`/`us_cr` override cannot be represented by
this unchanged legacy route. Missing metadata, unavailable endpoints, HTTP
failures and ambiguous responses remain errors. There is no fallback to a
constant URL and no attempt to bypass residency requirements.

## Automated evidence and its limits

`test/workspace-routing.test.mjs` executes the patched Desktop discovery class
with its bundled parsers, claims reader and semver functions, and its URL adapter.
It covers omitted/null/valid/malformed routing, native and compatibility account
mismatches, every managed-policy field, FedRAMP, exact version gating, endpoint
failures, missing/duplicate workspaces, different backend/override, changed
principals/policies and cancellation. Relay tests check unchanged capabilities
and account/policy RPC forwarding.

`test/integration/workspace-routing.mjs` runs with the actual supported image's
CLI `0.155.1` in the existing loopback-only CI namespace. It uses synthetic
ChatGPT credentials (rather than the old API-key/no-account fixture), reads the
real account and requirements responses through the relay, executes the v0.4.2
Desktop routing class and starts a real CLI thread and turn against the local
model fixture. The accounts endpoint's routing response is simulated and clearly
marked as such. This proves binary/protocol integration, not routing entitlement
for an existing live account.

The existing Desktop/browser integration suite remains required. A live account
test below is an additional acceptance requirement, not something the offline
fixture replaces. No live credentials belong in CI or diagnostic artifacts.

## Live acceptance test — requires explicit user approval

Do not change, restart, upgrade or redeploy the productive Web or CLI containers
for this procedure. It has not been performed by the implementation task.

Before execution, present the user with the reviewed PR revision, the exact
candidate Web image, its separate test port/profile and the proposed connection
to the unchanged existing CLI. Obtain approval specifically for that test.

- Build the candidate Web image from that revision without publishing a release.
  Run it as a separate, temporary Web instance, with its own user-data directory
  and a loopback-bound test port or equivalent access restriction.
- Connect it to the existing app-server using the approved socket/endpoint. Keep
  the production CLI image ID and configuration unchanged. Use its existing
  login through RPC; do not copy auth files, force token refresh or log tokens.
- Open the candidate UI, complete its normal startup and start a new chat in the
  agreed test workspace. Send one harmless message and confirm the response.
- Verify successful workspace-settings loading and successful `thread/start`
  and `turn/start`. In the candidate logs for this test interval, verify no
  `432 Workspace routing is unavailable` errors and no verifier rejection.
- Confirm the CLI image ID is unchanged and the production Web still uses its
  original image. Report only sanitized results, times and image/revision IDs.
- Stop and remove only the temporary test Web instance and its test profile.

If the actual bootstrap response lacks the required proof, keep the failure
closed. Record which requirement was not met, without exposing account IDs or
backend payloads. Do not silently replace the CLI: a version proposal would be
separate, supported by the concrete unmet requirement and its own real-binary
and live acceptance evidence.
