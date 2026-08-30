import assert from "node:assert/strict";
import test from "node:test";

import {
  basePathWithoutTrailingSlash,
  normalizeBasePath,
  pathAtBase,
} from "../src/server/base-path.ts";
import {
  addBrowserBasePath,
  mapBrowserPathToInitialRoute,
  mapBrowserPathToRoute,
  mapMemoryPathToBrowserPath,
  removeBrowserBasePath,
} from "../src/browser/routes.ts";

test("normalizes configured server base paths", () => {
  assert.equal(normalizeBasePath(undefined), "/");
  assert.equal(normalizeBasePath("/"), "/");
  assert.equal(normalizeBasePath("/my/example/subdir"), "/my/example/subdir/");
  assert.equal(
    normalizeBasePath("/my//example/subdir/"),
    "/my/example/subdir/",
  );
  assert.equal(
    pathAtBase("/my/example/", "/__backend/ipc"),
    "/my/example/__backend/ipc",
  );
  assert.equal(basePathWithoutTrailingSlash("/my/example/"), "/my/example");
});

test("rejects unsafe or non-path server base values", () => {
  for (const value of [
    "my/example",
    "//example/path",
    "/example/../path",
    "/example/%2F/path",
    "/example?query=yes",
    "/example#fragment",
    "/example path",
  ]) {
    assert.throws(() => normalizeBasePath(value), { name: "Error" });
  }
});

test("maps browser and in-memory routes below a configured base path", () => {
  const basePath = "/my/example/subdir/";

  assert.equal(
    removeBrowserBasePath("/my/example/subdir/thread/abc", basePath),
    "/thread/abc",
  );
  assert.equal(
    addBrowserBasePath("/thread/abc", basePath),
    "/my/example/subdir/thread/abc",
  );
  assert.equal(
    mapBrowserPathToRoute("/my/example/subdir/thread/abc", basePath),
    "/local/abc",
  );
  assert.deepEqual(mapMemoryPathToBrowserPath("/local/abc", basePath), {
    path: "/my/example/subdir/thread/abc",
  });
});

test("keeps root-path routing backward compatible", () => {
  assert.equal(mapBrowserPathToRoute("/thread/abc"), "/local/abc");
  assert.deepEqual(mapMemoryPathToBrowserPath("/"), {
    path: "/",
    titleChange: "Codex",
  });
});

test("maps PWA share targets below a configured base path", () => {
  const route = mapBrowserPathToInitialRoute(
    "/my/example/subdir/share/receive",
    "?title=Hello&text=World",
    "/my/example/subdir/",
  );

  assert.equal(route.browserPath, "/my/example/subdir/");
  const memoryUrl = new URL(route.memoryPath, "https://codex.example");
  assert.equal(
    memoryUrl.searchParams.get("prompt"),
    "title: Hello\ntext: World",
  );
});
