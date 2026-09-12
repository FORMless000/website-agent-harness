import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Harness } from "../src/harness.js";
import { createDriver } from "../src/agent.js";
import { resolveStyle } from "../src/styles.js";
import { variant, LEVELS, tokens } from "../src/compression.js";
import { sameRoot } from "../src/preparation.js";
import {
  artifact,
  catalog,
  testConfig,
  mockTransport,
  submission,
} from "./fixtures.js";
import { createSchema, type ParentSnapshot } from "../src/contracts.js";
const styled = (mode: "reuse" | "extend" | "new", css: string | null) => ({
  ...artifact(),
  schemaVersion: 2,
  css,
  style: { mode, rationale: "Fixture decision based on content" },
});

test("style decisions resolve pinned base once and enforce eligibility", () => {
  const base = {
    id: { sessionId: "a", versionId: "v" },
    css: "body{color:red}",
  };
  assert.equal(
    resolveStyle(styled("reuse", null), base).artifact.css,
    base.css,
  );
  assert.equal(
    resolveStyle(styled("extend", "p{color:blue}"), base).artifact.css,
    base.css + "\np{color:blue}",
  );
  assert.equal(resolveStyle(styled("new", null), base).artifact.css, null);
  assert.throws(() => resolveStyle(styled("reuse", null)));
  assert.throws(() => resolveStyle(styled("reuse", "p{}"), base));
  assert.throws(() => resolveStyle(styled("extend", null), base));
  assert.equal(sameRoot("/tomorrow/weather", "/tomorrow/archive/astro"), true);
  assert.equal(sameRoot("/tomorrow", "/tomorrow/weather"), true);
  assert.equal(sameRoot("/museum", "/tomorrow/weather"), false);
  assert.throws(() =>
    createSchema.parse({
      path: "/x",
      model: 1,
      parentContextMode: "full",
      externalReferences: [],
    }),
  );
  assert.throws(() =>
    createSchema.parse({
      path: "/x",
      model: 1,
      parentUrl: "https://example.org",
      internalCompression: "clean",
    }),
  );
});
test("four compression levels preserve dependencies and report omissions", () => {
  const source: ParentSnapshot = {
    url: "https://example.test",
    finalUrl: "https://example.test",
    capturedAt: "x",
    sha256: "x",
    warnings: [],
    html: `<html><head><title>Example</title><style>.inline{color:red}</style></head><body><nav><a href='/next'>Next</a></nav><aside>${"noise ".repeat(100)}</aside><main><h1>你好</h1><p class='kept'>${"Body text ".repeat(80)}</p><pre>  a\n  b</pre></main></body></html>`,
    stylesheets: [
      {
        url: "https://example.test/style.css",
        sha256: "x",
        css: "/*noise*/:root{--ink:red}.kept{color:var(--ink);animation:fade 1s}.absent{color:blue}.uncertain:hover{color:green}@media(max-width:600px){.kept{display:block}}@keyframes fade{from{opacity:0}to{opacity:1}}",
      },
    ],
  };
  const before = structuredClone(source);
  const variants = LEVELS.map((l) => variant(source, l));
  assert.deepEqual(source, before);
  for (const v of variants) {
    assert.equal(v.effectiveLevel, v.level);
    assert.ok(v.tokens.total > 0);
    assert.deepEqual(v, variant(source, v.level));
  }
  const relevant = variants[2];
  assert.doesNotMatch(relevant.css, /\.absent/);
  assert.match(relevant.css, /uncertain:hover/);
  assert.match(relevant.css, /@keyframes/);
  assert.match(relevant.css, /from\{opacity:0\}to\{opacity:1\}/);
  assert.match(relevant.css, /--ink/);
  assert.match(relevant.html, /你好/);
  assert.match(relevant.html, /  a\n  b/);
  assert.ok(relevant.omissions.length);
  const brief = variants[3];
  assert.match(brief.html, /Content outline/);
  assert.match(brief.css, /Custom properties/);
  const protectedCss = "body{color:rebeccapurple}";
  for (const level of LEVELS)
    assert.equal(
      variant(source, level, protectedCss).text.split(protectedCss).length - 1,
      1,
    );
  const broken = variant(
    { ...source, stylesheets: [{ url: "x", sha256: "x", css: "a{ ??? }" }] },
    "relevant",
  );
  assert.ok(broken.warnings.length);
  assert.ok(tokens("你好 hello") > 0);
  const ordered = variant(
    {
      ...source,
      html: '<link rel="stylesheet" href="/style.css"><style>p{color:orange}</style><main>Text</main>',
    },
    "clean",
  );
  assert.ok(ordered.css.indexOf("--ink") < ordered.css.indexOf("orange"));
});
test("preparation, same-root reuse, oldest ancestor, archive selected version and URL reuse", async () => {
  const config = await testConfig(),
    requests: Record<string, any>[] = [];
  const harness = new Harness(
    config,
    createDriver(
      mockTransport(
        [
          [submission(styled("new", "body{color:red}"), "a")],
          [submission(styled("extend", "p{color:blue}"), "b")],
          [submission(styled("reuse", null), "c")],
          [submission(styled("new", "body{color:green}"), "edit")],
          [submission(styled("new", null), "replacement")],
        ],
        requests,
      ),
    ),
    async () => catalog,
  );
  async function make(
    path: string,
    internalReference?: { sessionId: string; versionId: string },
  ) {
    const request = {
      path,
      model: 1,
      internalReference: internalReference ?? null,
      internalCompression: "brief",
    };
    const compared = await harness.prepareContext(request);
    assert.ok(compared.comparison.baseline > 0);
    const created = await harness.create({
      ...request,
      preparationId: compared.preparationId,
    });
    const run = await harness.wait(created.run.id);
    assert.equal(run.status, "success", run.error);
    return { sessionId: created.session.id, versionId: run.versionId! };
  }
  const a = await make("/root/a"),
    b = await make("/root/b", a),
    c = await make("/root/nested/c", b);
  assert.deepEqual((await harness.oldestAncestor(c)).reference, a);
  const vb = await harness.store.version(b.sessionId, b.versionId),
    vc = await harness.store.version(c.sessionId, c.versionId);
  assert.equal(vb.artifact.css, "body{color:red}\np{color:blue}");
  assert.equal(vc.artifact.css, vb.artifact.css);
  assert.equal(vc.style?.authoredCss, null);
  assert.equal(requests.length, 3);
  const run = await harness.start(a.sessionId, "Change color");
  assert.equal((await harness.wait(run.id)).status, "success");
  const archived = await harness.archive(a.sessionId, a.versionId);
  assert.equal(archived.archived?.versionId, a.versionId);
  assert.equal(await harness.store.byPath("/root/a"), undefined);
  assert.deepEqual(await harness.archive(a.sessionId, a.versionId), archived);
  await assert.rejects(
    () => harness.start(a.sessionId, "No edits"),
    /read-only/,
  );
  const replacement = await make("/root/a");
  assert.notEqual(replacement.sessionId, a.sessionId);
  assert.deepEqual((await harness.oldestAncestor(c)).reference, a);
  assert.equal((await harness.store.session(a.sessionId)).versions.length, 2);
  const events = await harness.store.events(
    (await harness.store.version(b.sessionId, b.versionId)).runId,
  );
  assert.ok(events.some((e) => e.type === "style.decision"));
  assert.ok(events.some((e) => e.type === "context.estimate"));
  const prepId = (await harness.store.session(b.sessionId)).preparationId!;
  const prep = JSON.parse(
    await readFile(harness.store.file("preparations", prepId), "utf8"),
  );
  assert.equal(prep.internal.source.html, artifact().html);
  await assert.rejects(
    () =>
      harness.prepareContext({
        path: "/changed",
        model: 1,
        preparationId: prepId,
        internalReference: a,
      }),
    /changed/,
  );
});
test("ancestry warnings and archival races leave history intact", async () => {
  const config = await testConfig();
  const harness = new Harness(
    config,
    async () => ({
      artifact: artifact(),
      pageDescription: "A small museum fixture.",
      staged: [],
      text: "fixture",
    }),
    async () => catalog,
  );
  const created = await harness.create({ path: "/root/a", model: 1 });
  await harness.wait(created.run.id);
  const session = await harness.store.session(created.session.id);
  const id = { sessionId: session.id, versionId: session.currentVersion! };
  session.generationParent = id;
  await harness.store.saveSession(session);
  assert.match((await harness.oldestAncestor(id)).warnings.join(""), /cycle/);
  session.generationParent = { sessionId: "missing", versionId: "missing" };
  await harness.store.saveSession(session);
  assert.deepEqual((await harness.oldestAncestor(id)).reference, id);
  await Promise.allSettled([
    harness.archive(session.id, id.versionId),
    harness.create({ path: session.path, model: 1 }),
  ]);
  await harness.archive(session.id, id.versionId);
  const archived = await harness.store.session(session.id);
  assert.ok(archived.archived);
});
