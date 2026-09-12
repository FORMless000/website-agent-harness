import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createPopulationDriver,
  Populations,
  validatePopulation,
  type PopulationContext,
  type PopulationResult,
  type PopulationRecord,
} from "../src/population.js";
import { Store, atomicWrite } from "../src/store.js";
import { Prompts } from "../src/prompts.js";
import { Harness } from "../src/harness.js";
import { createDriver } from "../src/agent.js";
import { indexDescriptions } from "../src/descriptions.js";
import {
  testConfig,
  mockTransport,
  artifact,
  submission,
  catalog,
} from "./fixtures.js";

export const result: PopulationResult = {
  brief: "A small museum guide with playful cards.",
  similarity: "insufficient_evidence",
  rationale: "No described neighbors",
  relevantNeighbors: [],
  externalReferences: [],
  referenceRecommendation: {
    action: "retain",
    reference: null,
    rationale: "Keep selected origin",
  },
  warnings: [],
};
const context: PopulationContext = {
  query: { path: "/museum/guide", manualInstructions: "Use purple." },
  referringUrl: null,
  allowReferenceSuggestions: false,
  neighbors: [],
  worldKnowledge: [],
};
const submit = (value: unknown, id = "p") => ({
  type: "function_call",
  id,
  call_id: id,
  name: "submit_population",
  arguments: JSON.stringify(value),
  status: "completed",
});
const record = (): PopulationRecord => ({
  id: "fixture",
  status: "running",
  startedAt: new Date().toISOString(),
  input: {
    path: context.query.path,
    description: context.query.manualInstructions,
    internalReference: null,
    allowReferenceSuggestions: false,
    model: 1,
    effort: "high",
  },
  context,
  instructions: "Use manual instructions. Submit the population result.",
});

test("population real SDK: isolated context, search settings, one submission, and separate usage", async () => {
  const config = await testConfig(),
    requests: Record<string, any>[] = [],
    events: { type: string; data: any }[] = [];
  const output = await createPopulationDriver(
    mockTransport([[submit(result)]], requests),
  )(config, record(), new AbortController().signal, async (type, data) => {
    events.push({ type, data });
  });
  assert.deepEqual(output, result);
  assert.equal(requests.length, 1);
  assert.match(JSON.stringify(requests[0].input), /Use purple/);
  assert.doesNotMatch(
    JSON.stringify(requests[0].input),
    /artifact|stylesheet|currentArtifact|availableAssets/,
  );
  const search = requests[0].tools.find(
    (t: any) => t.type === "openrouter:web_search",
  );
  assert.equal(search.parameters.max_uses, 2);
  assert.equal(search.parameters.engine, "exa");
  assert.doesNotMatch(JSON.stringify(requests[0].tools), /"format":"uri"/);
  assert.ok(events.some((e) => e.type === "usage"));
});
test("population URL validation stays local and provider schema errors retain their detail", async () => {
  for (const url of [
    "not a URL",
    "javascript:alert(1)",
    "https://user:secret@example.org",
  ]) {
    assert.throws(() =>
      validatePopulation(
        {
          ...result,
          externalReferences: [{ url, reason: "test", provenance: "test" }],
        },
        context,
      ),
    );
  }
  const config = await testConfig();
  const body = {
    error: {
      message: "Provider returned error",
      metadata: {
        raw: JSON.stringify({
          error: {
            message:
              "Invalid schema for submit_population: uri is not a valid format",
          },
        }),
      },
    },
  };
  await assert.rejects(
    () =>
      createPopulationDriver(
        async () =>
          new Response(JSON.stringify(body), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }),
      )(config, record(), new AbortController().signal, async () => {}),
    /HTTP 400: Invalid schema for submit_population/,
  );
});
test("population search evidence and repair reject ungrounded references; repair removes search", async () => {
  const config = await testConfig(),
    requests: Record<string, any>[] = [];
  const invalid = {
    ...result,
    externalReferences: [
      {
        url: "https://example.org/invented",
        reason: "invented",
        provenance: "invented",
      },
    ],
  };
  const output = await createPopulationDriver(
    mockTransport([[submit(invalid)], [submit(result, "repair")]], requests),
  )(config, record(), new AbortController().signal, async () => {});
  assert.deepEqual(output, result);
  assert.equal(requests.length, 2);
  assert.ok(
    !requests[1].tools.some((t: any) => t.type === "openrouter:web_search"),
  );
  const sourced = {
    ...result,
    externalReferences: [
      {
        url: "https://example.org/museum",
        reason: "Museum context",
        provenance: "museum search",
      },
    ],
  };
  const search = {
    type: "openrouter:web_search",
    id: "search1",
    status: "completed",
    action: {
      type: "search",
      query: "museum",
      sources: [{ type: "url", url: "https://example.org/museum" }],
    },
  };
  const withSource = await createPopulationDriver(
    mockTransport([[search, submit(sourced)]]),
  )(config, record(), new AbortController().signal, async () => {});
  assert.equal(
    withSource.externalReferences[0].url,
    sourced.externalReferences[0].url,
  );
});
test("population recommendation IDs and toggle are enforced", () => {
  assert.throws(() =>
    validatePopulation(
      {
        ...result,
        referenceRecommendation: {
          action: "clear",
          reference: null,
          rationale: "different",
        },
      },
      context,
    ),
  );
  assert.throws(() =>
    validatePopulation(
      {
        ...result,
        relevantNeighbors: [{ sessionId: "missing", versionId: "missing" }],
      },
      context,
    ),
  );
  assert.equal(
    validatePopulation(
      {
        ...result,
        referenceRecommendation: {
          action: "clear",
          reference: null,
          rationale: "different",
        },
      },
      { ...context, allowReferenceSuggestions: true },
    ).referenceRecommendation.action,
    "clear",
  );
});
test("new descriptions, historical blanks, and immutable referring snapshots", async () => {
  const config = await testConfig();
  const h = new Harness(
    config,
    createDriver(
      mockTransport([[submission(artifact())], [submission(artifact())]]),
    ),
    async () => catalog,
  );
  const first = await h.create({ path: "/museum", model: 1 });
  await h.wait(first.run.id);
  const saved = await h.store.session(first.session.id),
    version = await h.store.version(saved.id, saved.currentVersion!);
  assert.ok(version.pageDescription);
  const legacy = await h.create({
    path: "/other",
    model: 1,
    parentContextMode: "full",
  });
  await h.wait(legacy.run.id);
  const old = await h.store.session(legacy.session.id);
  const before = await readFile(
    h.store.file("sessions", old.id, `versions/${old.currentVersion}.json`),
    "utf8",
  );
  const descriptions = await indexDescriptions(h.store);
  assert.equal(
    descriptions.find((d) => d.sessionId === old.id)?.pageDescription,
    "",
  );
  assert.equal(
    await readFile(
      h.store.file("sessions", old.id, `versions/${old.currentVersion}.json`),
      "utf8",
    ),
    before,
  );
  await h.archive(old.id, old.currentVersion!);
  let captured: PopulationContext | undefined;
  const populations = new Populations(
    config,
    h.store,
    h.prompts,
    async (_c, r) => {
      captured = r.context;
      return result;
    },
  );
  const started = await populations.start({
    path: "/museum/new",
    model: 1,
    internalReference: { sessionId: old.id, versionId: old.currentVersion! },
  });
  while (populations.active.has(started.id))
    await new Promise((r) => setTimeout(r, 5));
  assert.equal((await populations.get(started.id)).status, "success");
  assert.equal(captured?.referringUrl, "/other");
  assert.equal(captured?.neighbors.length, 2);
  assert.deepEqual(captured?.worldKnowledge, []);
  assert.doesNotMatch(
    JSON.stringify(captured),
    /doctype|background:|history|assets/,
  );
});
test("cancellation, failure, and restart keep standalone population traces", async () => {
  const config = await testConfig(),
    store = new Store(config.dataDir),
    prompts = new Prompts(config.root);
  const populations = new Populations(
    config,
    store,
    prompts,
    async (_c, _r, signal) => {
      await new Promise<void>((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        }),
      );
      return result;
    },
  );
  const started = await populations.start({ path: "/test", model: 1 });
  await new Promise((r) => setTimeout(r, 10));
  populations.active.get(started.id)!.abort();
  while (populations.active.has(started.id))
    await new Promise((r) => setTimeout(r, 5));
  assert.equal((await populations.get(started.id)).status, "cancelled");
  assert.ok(
    (await populations.events(started.id)).some(
      (e) => e.type === "population.end",
    ),
  );
  assert.equal((await store.sessions()).length, 0);
  const interrupted = { ...record(), id: "interrupted" };
  await atomicWrite(
    store.file("populations", interrupted.id),
    JSON.stringify(interrupted),
  );
  assert.match((await populations.get(interrupted.id)).error!, /restart/);
  const failed = new Populations(config, store, prompts, async () => {
    throw new Error("Fixture provider failure");
  });
  const attempt = await failed.start({ path: "/failure", model: 1 });
  while (failed.active.has(attempt.id))
    await new Promise((r) => setTimeout(r, 5));
  assert.equal((await failed.get(attempt.id)).status, "failed");
});
