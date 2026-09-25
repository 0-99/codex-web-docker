#!/usr/bin/env node

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const assetsDirectory = process.argv[2];
if (!assetsDirectory) {
  throw new Error("Expected the extracted webview assets directory");
}

// The bundled Desktop translations are gated by a Statsig value whose offline
// fallback is false. Change only that fallback so the selected locale can load
// without a response from Statsig. Keep the match strict: upstream bundle
// changes should stop the build instead of silently disabling translations.
const fallback = /(\.get\(\s*`enable_i18n`\s*,\s*)!1(\s*\))/g;
const matches = [];

for (const name of readdirSync(assetsDirectory)) {
  if (!name.startsWith("app-") || !name.endsWith(".js")) continue;
  const path = join(assetsDirectory, name);
  const source = readFileSync(path, "utf8");
  for (const _match of source.matchAll(fallback)) {
    matches.push({ path, name, source });
  }
}

if (matches.length !== 1) {
  throw new Error(
    `Expected one enable_i18n offline fallback, found ${matches.length}`,
  );
}

const { path, name, source } = matches[0];
writeFileSync(path, source.replace(fallback, "$1!0$2"));
console.log(`Enabled the bundled translation fallback in ${name}`);
