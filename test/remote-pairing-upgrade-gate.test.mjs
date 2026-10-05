import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Review Settings → Connections against the real Desktop bundle before
// updating this value. The browser fixture only models its current markup.
const reviewedDesktopVersion = "26.901.41123";

test("a Desktop upgrade requires review of the remote pairing placement", () => {
  const prepare = readFileSync("scripts/prepare", "utf8");
  const pinnedVersion = prepare.match(/^APP_VERSION="([^"]+)"$/m)?.[1];
  assert.equal(
    pinnedVersion,
    reviewedDesktopVersion,
    "Desktop version changed: check the real Settings → Connections UI, then update the reviewed version in this test",
  );
});
