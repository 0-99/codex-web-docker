#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const directory = process.env.CODEX_WEB_AUTH_DIR || "/data/auth";
const file = path.join(directory, "credentials.json");
if (process.argv[2] !== "reset") {
  console.error("Usage: node docker/web-auth-reset.mjs reset");
  process.exit(2);
}
await fs.rm(file, { force: true });
console.log(
  "Web login reset. Restart the container and use the new setup code from its logs.",
);
