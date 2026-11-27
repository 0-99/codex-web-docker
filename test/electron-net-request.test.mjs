import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { NetRequest } from "../src/server/electron/net-request.js";

async function listen(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function body(response) {
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

test("Electron requests send headers and bodies and expose a readable response", async (t) => {
  const origin = await listen(t, async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.headers["x-preview"], "enabled");
    response.writeHead(201, { "content-type": "text/plain" });
    response.end(await body(request));
  });
  const request = new NetRequest({ url: origin, method: "POST" });
  request.setHeader("X-Preview", "enabled");
  const received = once(request, "response");
  request.end("preview payload");
  const [response] = await received;
  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.headers["content-type"], ["text/plain"]);
  assert.equal(await body(response), "preview payload");
});

test("manual redirects require approval and drop credentials across origins", async (t) => {
  const target = await listen(t, (request, response) => {
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    response.end("redirected preview");
  });
  const origin = await listen(t, (_, response) => {
    response.writeHead(302, { location: target });
    response.end();
  });
  const request = new NetRequest({ url: origin, redirect: "manual" });
  request.setHeader("Authorization", "Bearer synthetic-preview-token");
  request.setHeader("Cookie", "synthetic=1");
  request.once("redirect", (status, method, location) => {
    assert.equal(status, 302);
    assert.equal(method, "GET");
    assert.equal(location, target + "/");
    request.followRedirect();
  });
  const received = once(request, "response");
  request.end();
  assert.equal(await body((await received)[0]), "redirected preview");
});

test("an unapproved manual redirect aborts without requesting its destination", async (t) => {
  let requests = 0;
  const origin = await listen(t, (_, response) => {
    requests++;
    response.writeHead(302, { location: "/never-requested" });
    response.end();
  });
  const request = new NetRequest({ url: origin, redirect: "manual" });
  request.on("response", () =>
    assert.fail("A denied redirect has no response"),
  );
  const aborted = once(request, "abort");
  request.end();
  await aborted;
  assert.equal(requests, 1);
  assert.equal(request.destroyed, true);
});
