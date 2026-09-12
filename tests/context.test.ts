import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { prepareParent, initialContext } from "../src/context.js";
import { createSchema, type ParentSnapshot } from "../src/contracts.js";
import { Harness } from "../src/harness.js";
import { createDriver } from "../src/agent.js";
import {
  artifact,
  catalog,
  testConfig,
  mockTransport,
  submission,
} from "./fixtures.js";

function snapshot(html: string): ParentSnapshot {
  return {
    url: "https://example.test/old",
    finalUrl: "https://example.test/parent",
    capturedAt: "volatile-time",
    sha256: "volatile-hash",
    localVersion: "volatile-version",
    warnings: [],
    html,
    stylesheets: [
      {
        url: "https://example.test/theme.css",
        css: ":root { --ink: red; }",
        sha256: "css-hash",
      },
    ],
  };
}
test("pre-refactor SDK string history can still be edited without rewriting it", async () => {
  const config = await testConfig();
  const requests: Record<string, any>[] = [];
  const driver = createDriver(
    mockTransport(
      [[submission(artifact())], [submission(artifact(), "legacy-edit")]],
      requests,
    ),
  );
  let first = true;
  const harness = new Harness(
    config,
    (context) => {
      if (!first) return driver(context);
      first = false;
      return driver({
        ...context,
        input: '{"description":"Legacy string input"}',
        cachePrefix: undefined,
      });
    },
    async () => catalog,
  );
  const created = await harness.create({ path: "/legacy", model: 1 });
  assert.equal((await harness.wait(created.run.id)).status, "success");
  const stored = await harness.store.session(created.session.id);
  delete stored.contextVersion;
  delete stored.parentContextMode;
  await harness.store.saveSession(stored);
  const edit = await harness.start(stored.id, "Edit the legacy website");
  assert.equal((await harness.wait(edit.id)).status, "success");
  assert.equal(requests[0].input, '{"description":"Legacy string input"}');
  assert.match(JSON.stringify(requests[1].input), /Legacy string input/);
  assert.match(JSON.stringify(requests[1].input), /Edit the legacy website/);
});
test("full source is deterministic, minimally wrapped, cleaned without changing CSS or original snapshot", () => {
  const parent = snapshot(
    '<!doctype html><html><head><title>Title</title><script>bad()</script><script type="application/ld+json">{"name":"Museum"}</script></head><body><!--noise--><p onclick="bad()" class="x" style="color:red">A  B\nC</p><svg><path d="M0 0"/></svg></body></html>',
  );
  const original = structuredClone(parent);
  const result = prepareParent(parent);
  assert.deepEqual(parent, original);
  assert.equal(result.effectiveMode, "full");
  assert.doesNotMatch(
    result.text,
    /bad\(\)|onclick|noise|volatile|css-hash|example.test\/old/,
  );
  assert.match(result.text, /application\/ld\+json/);
  assert.match(result.text, /A  B\nC/);
  assert.match(result.text, /<path d="M0 0"/);
  assert.ok(result.text.endsWith(parent.stylesheets[0].css));
  assert.ok(result.text.includes("https://example.test/theme.css"));
  assert.deepEqual(
    result,
    prepareParent({
      ...parent,
      capturedAt: "changed",
      sha256: "changed",
      localVersion: "changed",
    }),
  );
});
test("compact keeps headings/navigation, whitespace-sensitive text and CSS; summarizes repetitions and image geometry", () => {
  const long = "x".repeat(250);
  const parent = snapshot(
    `<html><body><h1>${long}</h1><nav>${"<a href='/a'>Link</a>".repeat(5)}</nav><section>${`<p class="item">${long}</p>\n`.repeat(7)}</section><pre>${long}\n  y</pre><label>${long}</label><svg width="30" height="20" aria-label="Star"><title>Star</title><path d="M0 0 L999 999"/></svg><img width="20" alt="Picture" src="data:image/png;base64,AAAA"></body></html>`,
  );
  const result = prepareParent(parent, "compact");
  assert.equal(result.effectiveMode, "compact");
  assert.match(result.text, /4 repeated sibling subtree\(s\) omitted/);
  assert.equal(result.text.match(/class="item"/g)?.length, 3);
  assert.equal(result.text.match(/href="\/a"/g)?.length, 5);
  assert.ok(result.text.includes(`<h1>${long}</h1>`));
  assert.ok(result.text.includes(`<pre>${long}\n  y</pre>`));
  assert.ok(result.text.includes(`<label>${long}</label>`));
  assert.match(result.text, /SVG geometry omitted/);
  assert.match(result.text, /width="30" height="20" aria-label="Star"/);
  assert.match(result.text, /<title>Star<\/title>/);
  assert.doesNotMatch(result.text, /M0 0 L999|AAAA/);
  assert.ok(result.preparedChars < result.originalChars);
  assert.ok(result.text.endsWith(parent.stylesheets[0].css));
  assert.deepEqual(result, prepareParent(parent, "compact"));
  const styles = prepareParent(
    snapshot(
      `<body>${"<style>.x { color: red; }</style>".repeat(5)}${"<section><h2>Keep heading</h2></section>".repeat(5)}</body>`,
    ),
    "compact",
  );
  assert.equal(styles.text.match(/\.x \{ color: red; \}/g)?.length, 5);
  assert.equal(styles.text.match(/Keep heading/g)?.length, 5);
  const deep = prepareParent(
    snapshot("<div>".repeat(140) + "text" + "</div>".repeat(140)),
    "compact",
  );
  assert.equal(deep.effectiveMode, "full");
  assert.equal(deep.warnings.length, 1);
});
test("initial blocks share stable references, preserve attribution, and serialize task intent only once", () => {
  const parent = prepareParent(snapshot("<h1>Reference</h1>"));
  const assets = [
    {
      id: "internal",
      url: "/_assets/a.png",
      mime: "image/png",
      bytes: 100,
      source: "openverse" as const,
      creator: "Artist",
      license: "CC BY",
      sourceUrl: "https://example.test/photo",
      usage: { cost: 7 },
      prompt: "unneeded",
    },
  ];
  const a = initialContext(
    "/one",
    "Unique description",
    catalog[0].id,
    parent,
    assets,
  );
  const b = initialContext(
    "/two",
    "Another description",
    catalog[0].id,
    parent,
    assets,
  );
  assert.equal(a.cachePrefix, b.cachePrefix);
  assert.deepEqual(
    a.input[0].content.slice(0, -1),
    b.input[0].content.slice(0, -1),
  );
  assert.equal(JSON.stringify(a.input).match(/Unique description/g)?.length, 1);
  assert.doesNotMatch(JSON.stringify(a.input), /internal|unneeded|bytes|cost/);
  assert.match(a.cachePrefix, /Artist|CC BY/);
  assert.deepEqual(a.input[0].content.at(-2)?.promptCacheBreakpoint, {
    mode: "explicit",
  });
  const deepseek = initialContext("/one", "", catalog[4].id, parent, []);
  assert.equal(deepseek.input[0].content[0].promptCacheBreakpoint, undefined);
  const empty = initialContext("/one", "", catalog[0].id, undefined, []);
  assert.deepEqual(empty.input[0].content, [
    { type: "input_text", text: "Target sub-URL: /one" },
  ]);
  assert.equal(
    createSchema.parse({ path: "/x", model: 1 }).parentContextMode,
    "full",
  );
  assert.throws(() =>
    createSchema.parse({ path: "/x", model: 1, parentContextMode: "invalid" }),
  );
});
test("real SDK wire payload: stable affinity, cache boundary, repair history, persisted transformation, and legacy edit", async () => {
  const config = await testConfig();
  const requests: Record<string, any>[] = [];
  const affinity: (string | null)[] = [];
  const transport = mockTransport(
    [
      [submission(artifact())], // parent
      [submission({ ...artifact(), html: "invalid" }, "bad")],
      [submission(artifact(), "repair")],
      [submission(artifact(), "sibling")],
      [submission(artifact(), "openai")],
      [submission(artifact(), "deepseek")],
      [submission(artifact(), "edit")],
    ],
    requests,
  );
  const harness = new Harness(
    config,
    createDriver(async (input, init) => {
      const request = new Request(input, init);
      affinity.push(request.headers.get("x-session-id"));
      return transport(request);
    }),
    async () => catalog,
  );
  const parent = await harness.create({ path: "/parent", model: 1 });
  const parentRun = await harness.wait(parent.run.id);
  assert.equal(parentRun.status, "success", parentRun.error);
  assert.deepEqual(requests[0].cache_control, { type: "ephemeral" });
  const parentUrl = `http://127.0.0.1:${config.port}/parent`;
  const first = await harness.create({
    path: "/one",
    model: 1,
    parentUrl,
    description: "First child",
  });
  assert.equal((await harness.wait(first.run.id)).status, "success");
  const second = await harness.create({ path: "/two", model: 1, parentUrl });
  assert.equal((await harness.wait(second.run.id)).status, "success");
  assert.equal(affinity[1], affinity[2]);
  assert.equal(affinity[1], affinity[3]);
  assert.ok(affinity[1]?.startsWith("vibenet-"));
  assert.deepEqual(requests[1].input[0].content[0].prompt_cache_breakpoint, {
    mode: "explicit",
  });
  assert.deepEqual(
    requests[1].input[0].content[0],
    requests[3].input[0].content[0],
  );
  assert.equal(
    JSON.stringify(requests[2].input).match(/Parent reference —/g)?.length,
    1,
  );
  assert.match(JSON.stringify(requests[2].input), /function_call_output/);
  assert.equal(
    JSON.stringify(requests[1].input).match(/First child/g)?.length,
    1,
  );
  assert.ok(
    requests[1].instructions.indexOf("assets.md") <
      requests[1].instructions.indexOf("initial-generation.md"),
  );
  const prepared = JSON.parse(
    await readFile(
      harness.store.file("runs", first.run.id, "parent-context.json"),
      "utf8",
    ),
  );
  assert.equal(prepared.text, requests[1].input[0].content[0].text);
  for (const model of [2, 5]) {
    const created = await harness.create({
      path: `/model-${model}`,
      model,
      parentUrl,
      parentContextMode: "compact",
    });
    assert.equal((await harness.wait(created.run.id)).status, "success");
    assert.equal(
      (await harness.store.session(created.session.id)).parentContextMode,
      "compact",
    );
  }
  assert.deepEqual(requests[4].input[0].content[0].prompt_cache_breakpoint, {
    mode: "explicit",
  });
  assert.equal(
    requests[5].input[0].content[0].prompt_cache_breakpoint,
    undefined,
  );
  const old = await harness.store.session(first.session.id);
  delete old.contextVersion;
  delete old.parentContextMode;
  await harness.store.saveSession(old);
  const edit = await harness.start(old.id, "Legacy session edit");
  assert.equal((await harness.wait(edit.id)).status, "success");
  assert.match(JSON.stringify(requests[6].input), /First child/);
  assert.match(JSON.stringify(requests[6].input), /Legacy session edit/);
  assert.equal(
    (await harness.store.session(old.id)).parent?.html,
    artifact().html,
  );
});
