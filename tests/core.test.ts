import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizePath } from "../src/contracts.js";
import {
  validateArtifact,
  renderArtifact,
  rasterType,
} from "../src/validation.js";
import { isPublicAddress, publicUrl, captureParent } from "../src/network.js";
import { createDriver, redact } from "../src/agent.js";
import { Harness } from "../src/harness.js";
import { AssetTools } from "../src/assets.js";
import { requireCapability, resolveModel } from "../src/models.js";
import {
  artifact,
  catalog,
  testConfig,
  mockTransport,
  submission,
  reasoning,
} from "./fixtures.js";

test("paths are canonical and cannot occupy control routes or traverse", () => {
  assert.equal(normalizePath("/museum/room/"), "/museum/room");
  assert.equal(normalizePath("/caf%C3%A9"), "/café");
  for (const path of [
    "/",
    "//host",
    "/a/../b",
    "/a/%2e%2e/b",
    "/a%2fb",
    "/a%252fb",
    "/api",
    "/_harness/x",
    "/_assets/a",
    "/x?y",
    "/x#z",
    "/x\\y",
    "/x%00",
    "/x//y",
  ])
    assert.throws(() => normalizePath(path), path);
});
test("HTML/CSS accepted; script, remote-resource and schema failures return feedback", () => {
  assert.deepEqual(validateArtifact(artifact(), []).errors, []);
  assert.deepEqual(
    validateArtifact(
      {
        ...artifact(),
        css: ":root{--ink:#222;--gap:1rem}body{color:var(--ink);padding:var(--gap)}",
      },
      [],
    ).errors,
    [],
  );
  assert.ok(
    validateArtifact(
      {
        ...artifact(),
        css: ":root{--image:url(https://evil.test/a.png)}body{background:var(--image)}",
      },
      [],
    ).errors.length,
  );
  const snippets = [
    "<script>alert(1)</script>",
    '<img src="https://evil.test/a.png">',
    '<p onclick="alert(1)">x</p>',
    '<a href="javascript:alert(1)">x</a>',
    '<iframe srcdoc="x"></iframe>',
    '<meta http-equiv="refresh" content="0;url=https://evil.test">',
    '<svg><a href="javascript:alert(1)">x</a></svg>',
    '<form action="https://evil.test"><input></form>',
    "<style>body{color:red}</style>",
  ];
  for (const snippet of snippets) {
    const value = artifact();
    value.html = value.html.replace("</body>", `${snippet}</body>`);
    assert.ok(validateArtifact(value, []).errors.length, snippet);
  }
  for (const css of [
    '@import "https://evil.test/a.css";',
    "body{background:url(https://evil.test/x)}",
    "p { color: }",
    "</style><script>x</script>",
    'p{background:image-set("https://evil.test/a.png" 1x)}',
  ])
    assert.ok(validateArtifact({ ...artifact(), css }, []).errors.length, css);
  assert.ok(validateArtifact({ ...artifact(), extra: true }, []).errors.length);
  assert.ok(
    validateArtifact(
      { schemaVersion: 1, html: "<h1>Not a document</h1>", css: null },
      [],
    ).errors.length,
  );
  assert.match(renderArtifact(artifact(), []), /<style>/);
});
test("network guard rejects all private and special addresses", () => {
  for (const ip of [
    "127.0.0.1",
    "10.2.3.4",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
  ])
    assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  for (const url of [
    "file:///etc/passwd",
    "ftp://example.com",
    "https://user:pass@example.com",
    "http://example.com:8787",
  ])
    assert.throws(() => publicUrl(url));
});
test("asset tools follow startup switches; keys are redacted, raster signatures checked", async () => {
  const config = await testConfig();
  for (const [mode, count] of [
    ["none", 0],
    ["openverse", 2],
    ["generated", 1],
    ["both", 3],
  ] as const)
    assert.equal(
      new AssetTools(
        { ...config, assets: mode },
        async () => {},
        new AbortController().signal,
      ).tools().length,
      count,
    );
  assert.throws(() => rasterType(Buffer.from("<svg></svg>")));
  assert.deepEqual(
    redact(
      {
        authorization: "Bearer secret",
        text: "prefix secret sk-or-v1-testcredential",
        inputTokens: 30,
      },
      "secret",
    ),
    {
      authorization: "[REDACTED]",
      text: "prefix [REDACTED] [REDACTED]",
      inputTokens: 30,
    },
  );
});
test("no default model and explicit capability errors", () => {
  assert.throws(() => resolveModel(""));
  assert.equal(resolveModel(5).id, catalog[4]!.id);
  assert.equal(resolveModel(6).id, "deepseek/deepseek-v4.1-flash");
  assert.equal(resolveModel("deepseek/deepseek-v4.1-flash").number, 6);
  assert.equal(
    requireCapability(catalog, resolveModel(6).id, "low").id,
    resolveModel(6).id,
  );
  assert.throws(() => requireCapability([], catalog[0]!.id, "high"));
  assert.throws(() => requireCapability(catalog, catalog[0]!.id, "medium"));
});
test("real SDK: repair, publish, persistent reasoning, edit and failed-edit preservation", async () => {
  const config = await testConfig();
  const requests: Record<string, unknown>[] = [];
  const invalid = {
    ...artifact(),
    html: artifact().html.replace("</body>", "<script>x()</script></body>"),
  };
  const driver = createDriver(
    mockTransport(
      [
        [reasoning, submission(invalid, "bad")],
        [submission(artifact(), "fixed")],
        [submission(artifact("A tiny museum, revised"), "edit")],
        [],
      ],
      requests,
    ),
  );
  const harness = new Harness(config, driver, async () => catalog);
  const created = await harness.create({
    path: "/museum",
    model: 1,
    description: "Make a tiny museum.",
  });
  const run = await harness.wait(created.run.id);
  assert.equal(run.status, "success", run.error);
  assert.equal(run.submissions, 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.max_output_tokens, undefined);
  assert.equal(requests[0]!.parallel_tool_calls, undefined);
  assert.equal(requests[0]!.truncation, "disabled");
  assert.deepEqual(requests[0]!.reasoning, { effort: "high" });
  assert.equal(
    (requests[0]!.provider as Record<string, unknown>).require_parameters,
    true,
  );
  assert.equal(
    (requests[0]!.tools as Record<string, unknown>[])[0]!.strict,
    true,
  );
  assert.match(JSON.stringify(requests[1]), /not allowed/);
  const first = await harness.store.session(created.session.id);
  const firstVersion = await harness.store.version(
    first.id,
    first.currentVersion!,
  );
  const state = await readFile(
    harness.store.file("sessions", first.id, "state.json"),
    "utf8",
  );
  assert.match(state, /opaque-test-value/);
  const edit = await harness.start(
    first.id,
    "Rename it, preserving everything else.",
  );
  assert.equal((await harness.wait(edit.id)).status, "success");
  assert.match(JSON.stringify(requests[2]), /opaque-test-value/);
  assert.match(JSON.stringify(requests[2]), /Make a tiny museum/);
  assert.match(JSON.stringify(requests[2]), /Rename it/);
  const second = await harness.store.session(first.id);
  assert.equal(second.versions.length, 2);
  assert.equal(second.model, first.model);
  assert.deepEqual(
    await harness.store.version(first.id, firstVersion.id),
    firstVersion,
  );
  const failure = await harness.start(
    first.id,
    "This provider response has no submission.",
  );
  assert.equal((await harness.wait(failure.id)).status, "failed");
  assert.equal(
    (await harness.store.session(first.id)).currentVersion,
    second.currentVersion,
  );
  const events = await harness.store.events(run.id);
  assert.equal(events.at(-1)!.type, "run.end");
  assert.deepEqual(
    events.map((e) => e.seq),
    events.map((_, i) => i + 1),
  );
  assert.ok(events.some((e) => e.type === "request"));
  assert.ok(events.some((e) => e.type === "context"));
  const parent = await captureParent(
    "http://127.0.0.1:18787/museum",
    harness.store,
    18787,
  );
  assert.equal(parent.localVersion, second.currentVersion);
  assert.ok(parent.stylesheets.length);
  await assert.rejects(
    () => harness.create({ path: "/museum/", model: 1 }),
    /already has a session/,
  );
});
test("failed runs, cancellation, locks and prompt conflicts are explicit", async () => {
  const config = await testConfig();
  const harness = new Harness(
    config,
    async (ctx) => {
      ctx.signal.throwIfAborted();
      await new Promise<void>((_, reject) =>
        ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), {
          once: true,
        }),
      );
      throw new Error("unreachable");
    },
    async () => catalog,
  );
  const created = await harness.create({ path: "/cancel", model: 1 });
  await assert.rejects(
    () => harness.start(created.session.id, "Concurrent"),
    /active run/,
  );
  harness.cancel(created.run.id);
  assert.equal((await harness.wait(created.run.id)).status, "cancelled");
  const prompts = await harness.prompts.list();
  const prompt = prompts[0]!;
  await harness.prompts.save(
    prompt.name,
    prompt.content + "\nTest.",
    prompt.sha256,
  );
  await assert.rejects(
    () => harness.prompts.save(prompt.name, "overwrite", prompt.sha256),
    /changed on disk/i,
  );
  const missingKey = new Harness(
    { ...config, dataDir: config.dataDir + "-no-key", apiKey: "" },
    undefined,
    async () => catalog,
  );
  const session = await missingKey.create({ path: "/no-key", model: 1 });
  assert.match(
    (await missingKey.wait(session.run.id)).error!,
    /OPENROUTER_API_KEY/,
  );
  const interrupted = {
    ...created.run,
    id: "interrupted",
    status: "running" as const,
  };
  await harness.store.saveRun(interrupted);
  const record = await harness.store.session(created.session.id);
  record.runs.push(interrupted.id);
  await harness.store.saveSession(record);
  await harness.store.recoverInterrupted();
  assert.equal((await harness.store.run(interrupted.id)).status, "failed");
});

test("manual loop obeys the exact step limit without a trailing paid request", async () => {
  const config = await testConfig();
  config.maxSteps = 2;
  const requests: Record<string, unknown>[] = [];
  const invalid = {
    schemaVersion: 1,
    html: "not a complete document",
    css: null,
  };
  const harness = new Harness(
    config,
    createDriver(
      mockTransport(
        [[submission(invalid, "one")], [submission(invalid, "two")]],
        requests,
      ),
    ),
    async () => catalog,
  );
  const result = await harness.create({ path: "/step-limit", model: 1 });
  const run = await harness.wait(result.run.id);
  assert.equal(run.status, "failed");
  assert.equal(run.steps, 2);
  assert.equal(run.submissions, 2);
  assert.equal(requests.length, 2);
  assert.equal(
    (await harness.store.session(result.session.id)).currentVersion,
    undefined,
  );
});

test("a restarted driver pairs interrupted manual calls before a new user edit", async () => {
  const config = await testConfig();
  const requests: Record<string, unknown>[] = [];
  const driver = createDriver(
    mockTransport(
      [
        [reasoning, submission(artifact(), "interrupted-call")],
        [submission(artifact("Recovered museum"), "recovered-call")],
      ],
      requests,
    ),
  );
  let crash = true;
  const harness = new Harness(
    config,
    (ctx) =>
      driver({
        ...ctx,
        emit: async (type, data) => {
          if (crash && type === "tool.result") {
            crash = false;
            throw new Error(
              "Simulated process interruption before saving tool results.",
            );
          }
          await ctx.emit(type, data);
        },
      }),
    async () => catalog,
  );
  const initial = await harness.create({ path: "/restart", model: 1 });
  assert.equal((await harness.wait(initial.run.id)).status, "failed");
  const resumed = await harness.start(
    initial.session.id,
    "Try again after restart.",
  );
  const run = await harness.wait(resumed.id);
  assert.equal(run.status, "success", run.error);
  const input = requests[1]!.input as {
    type: string;
    call_id?: string;
    output?: string;
  }[];
  assert.ok(
    input.some(
      (item) =>
        item.type === "function_call_output" &&
        item.call_id === "interrupted-call" &&
        item.output?.includes("Previous run interrupted"),
    ),
  );
  assert.match(JSON.stringify(input), /opaque-test-value/);
  assert.ok(
    (await harness.store.events(run.id)).some(
      (event) => event.type === "state.recovered",
    ),
  );
});

test("empty provider responses with a deliberately slow trace sink are handled without unhandled rejections", async () => {
  const config = await testConfig();
  const harness = new Harness(
    config,
    (context) =>
      createDriver(mockTransport([[]]))({
        ...context,
        emit: async (type, data) => {
          if (type === "provider.event")
            await new Promise((resolve) => setTimeout(resolve, 15));
          await context.emit(type, data);
        },
      }),
    async () => catalog,
  );
  for (let index = 0; index < 3; index++) {
    const created = await harness.create({
      path: `/empty-response-${index}`,
      model: 1,
    });
    const run = await harness.wait(created.run.id);
    assert.equal(run.status, "failed");
    assert.match(run.error!, /empty|output/);
    assert.ok(
      (await harness.store.events(run.id)).some(
        (event) => event.type === "provider.event",
      ),
    );
  }
});
