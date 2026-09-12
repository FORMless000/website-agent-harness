import { test } from "node:test";
import assert from "node:assert/strict";
import { captureParent, fetchPublic } from "../src/network.js";
import { Store, hash } from "../src/store.js";
import { testConfig } from "./fixtures.js";

test("parent capture respects redirects, document base, case-insensitive rel, deduplication and source hashes", async () => {
  const config = await testConfig();
  const requests: { url: string; limit: number }[] = [];
  const html =
    '<!doctype html><html><head><base href="/assets/"><base href="https://ignored.example/"><link rel="alternate STYLESHEET" href="theme.css"><link rel="stylesheet" href="theme.css"><link rel="stylesheet" href="https://cdn.example/remote.css"><link rel="stylesheet" href="bad.css"></head><body><script>notExecuted()</script><p>Parent source</p></body></html>';
  const css = ":root{--color:tomato}body{color:var(--color)}";
  const fetcher: typeof fetchPublic = async (url, limit) => {
    requests.push({ url, limit });
    if (url === "https://example.com/start")
      return {
        url: "https://example.com/redirected/page",
        mime: "text/html",
        body: Buffer.from(html),
      };
    if (url === "https://example.com/assets/theme.css")
      return { url, mime: "text/css", body: Buffer.from(css) };
    if (url === "https://example.com/assets/bad.css")
      throw new Error("Fixture HTTP 404");
    throw new Error(`Unexpected URL: ${url}`);
  };
  const snapshot = await captureParent(
    "https://example.com/start",
    new Store(config.dataDir),
    config.port,
    fetcher,
  );
  assert.equal(snapshot.html, html);
  assert.equal(snapshot.sha256, hash(html));
  assert.equal(snapshot.finalUrl, "https://example.com/redirected/page");
  assert.deepEqual(snapshot.stylesheets, [
    {
      url: "https://example.com/assets/theme.css",
      sourceUrl: "https://example.com/assets/theme.css",
      css,
      sha256: hash(css),
    },
  ]);
  assert.equal(requests.length, 3);
  assert.equal(requests[2]!.limit, 1048576 - Buffer.byteLength(css));
  assert.ok(
    snapshot.warnings.some((w) =>
      w.includes("Cross-origin stylesheet omitted"),
    ),
  );
  assert.ok(snapshot.warnings.some((w) => w.includes("Fixture HTTP 404")));
  assert.match(snapshot.html, /notExecuted/); // Source is preserved, never evaluated.
});

test("parent stylesheet capture bounds work and rejects non-HTML parents", async () => {
  const config = await testConfig();
  const store = new Store(config.dataDir);
  let calls = 0;
  const html = `<html><head>${Array.from({ length: 10 }, (_, i) => `<link rel="stylesheet" href="/${i}.css">`).join("")}</head><body></body></html>`;
  const fetcher: typeof fetchPublic = async (url) => {
    calls++;
    return {
      url,
      mime: calls === 1 ? "text/html" : "text/css",
      body: Buffer.from(calls === 1 ? html : "body{color:black}"),
    };
  };
  const snapshot = await captureParent(
    "https://example.com/",
    store,
    config.port,
    fetcher,
  );
  assert.equal(calls, 9);
  assert.equal(snapshot.stylesheets.length, 8);
  assert.ok(snapshot.warnings.some((w) => w.includes("first eight")));
  await assert.rejects(
    () =>
      captureParent(
        "https://example.com/image",
        store,
        config.port,
        async (url) => ({
          url,
          mime: "image/png",
          body: Buffer.from("not html"),
        }),
      ),
    /must return HTML/,
  );
});
