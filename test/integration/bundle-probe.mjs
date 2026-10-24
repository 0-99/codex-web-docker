import fs from "node:fs";
import path from "node:path";

const root = "/opt/codex-web/scratch/asar";
const directories = [".vite/build", "webview/assets"];
const probes = [
  { name: "gh-version", needle: /["'`]gh["'`]/g, nearby: "--version", limit: 6 },
  { name: "gh-literal", needle: /["'`]gh["'`]/g, limit: 40, before: 160, after: 300 },
  { name: "fs-read-file", needle: /fs\/readFile/g, limit: 8 },
  { name: "cloudflare-challenge", needle: /cloudflare_challenge/g, limit: 3 },
  { name: "optimized-check", needle: /accounts\/optimized\/check/g, limit: 3 },
];
const counts = new Map();

function* files(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* files(name);
    else if (entry.isFile() && name.endsWith(".js") && fs.statSync(name).size < 25_000_000) yield name;
  }
}

for (const directory of directories) {
  for (const file of files(path.join(root, directory))) {
    const source = fs.readFileSync(file, "utf8");
    for (const probe of probes) {
      for (const match of source.matchAll(probe.needle)) {
        if ((counts.get(probe.name) ?? 0) >= probe.limit) break;
        const start = Math.max(0, match.index - (probe.before ?? 900));
        const end = Math.min(source.length, match.index + (probe.after ?? 1200));
        const excerpt = source.slice(start, end);
        if (probe.nearby && !excerpt.includes(probe.nearby)) continue;
        counts.set(probe.name, (counts.get(probe.name) ?? 0) + 1);
        console.log(JSON.stringify({
          probe: probe.name,
          file: path.relative(root, file),
          offset: match.index,
          excerpt,
        }));
      }
    }
  }
}
for (const probe of probes) {
  console.log(JSON.stringify({ probe: probe.name, matches: counts.get(probe.name) ?? 0 }));
}
