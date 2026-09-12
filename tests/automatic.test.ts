import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Harness } from "../src/harness.js";
import { AutomaticPages, selectReference } from "../src/automatic.js";
import { Settings } from "../src/settings.js";
import { createHttpServer } from "../src/server.js";
import { artifact, catalog, testConfig } from "./fixtures.js";
import type { Driver } from "../src/agent.js";
import type { PopulationDriver, PopulationResult } from "../src/population.js";
import { atomicWrite } from "../src/store.js";
import type { Session } from "../src/contracts.js";
const brief: PopulationResult = {
  brief: "A populated website brief",
  similarity: "insufficient_evidence",
  rationale: "Fixture",
  relevantNeighbors: [],
  externalReferences: [],
  warnings: [],
  referenceRecommendation: {
    action: "retain",
    reference: null,
    rationale: "Keep origin",
  },
};
const output = () => ({
  artifact: artifact(),
  staged: [],
  text: "Fixture",
  pageDescription: "Actual fixture page",
});
const headers = {
  "Content-Type": "application/json",
  "X-Harness-Request": "1",
};
async function setup(
  driver: Driver = async () => output(),
  population: PopulationDriver = async () => brief,
) {
  const config = await testConfig();
  const harness = new Harness(config, driver, async () => catalog, population);
  const automatic = new AutomaticPages(harness);
  return { config, harness, automatic };
}
async function change(
  automatic: AutomaticPages,
  update: Record<string, unknown>,
) {
  const { settings, revision } = await automatic.settings.get();
  return automatic.settings.save({
    settings: { ...settings, ...update },
    revision,
  });
}
function gate() {
  let release!: () => void;
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}

test("HTTP unknown navigation uses one population/create, private loading status, reference and ordinary traces", async () => {
  const seen: string[] = [];
  const { harness, automatic, config } = await setup(
    async (request) => {
      seen.push("website");
      assert.equal(request.model, "deepseek/deepseek-v4.1-flash");
      assert.equal(request.effort, "low");
      assert.match(JSON.stringify(request.input), /populated website brief/);
      return output();
    },
    async (_config, record) => {
      seen.push("population");
      assert.equal(record.input.model, "deepseek/deepseek-v4.1-flash");
      assert.equal(record.input.effort, "low");
      assert.equal(record.input.allowReferenceSuggestions, false);
      return brief;
    },
  );
  const server = createHttpServer(harness, automatic);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  config.port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${config.port}`;
  try {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => fetch(origin + "/new/path?q=one")),
    );
    const html = await responses[0].text();
    assert.match(html, /Loading…/);
    assert.doesNotMatch(html, /population|reasoning|trace|__ATTEMPT__/);
    const id = /data-attempt="([\w-]+)"/.exec(html)![1];
    const record = await automatic.wait(id);
    assert.equal(record.status, "success", record.error);
    assert.deepEqual(seen, ["population", "website"]);
    assert.equal((await automatic.list()).length, 1);
    const status = await (
      await fetch(`${origin}/api/automatic/${id}/status`)
    ).json();
    assert.deepEqual(status, {
      id,
      status: "success",
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      phase: "preparing",
    });
    const page = await fetch(origin + "/new/path?q=two");
    assert.match(await page.text(), /A tiny museum/);
    assert.match(
      page.headers.get("content-security-policy")!,
      /script-src 'none'/,
    );
    assert.equal(page.headers.get("referrer-policy"), "same-origin");
    assert.equal((await harness.store.sessions()).length, 1);
    const session = await harness.store.session(record.sessionId!);
    assert.equal(session.description, "");
    assert.equal(session.populatedBrief, brief.brief);
    assert.equal(session.populationId, record.populationId);
    assert.ok(
      (await harness.store.events(record.runId!)).some(
        (e) => e.type === "population.link",
      ),
    );
    assert.ok(
      (await harness.populations.events(record.populationId!)).some(
        (e) => e.type === "population.end",
      ),
    );
    const rejected = [
      ["/_settings/missing", {}],
      ["/_harness/missing", {}],
      ["/api/missing", {}],
      ["/_assets/missing.png", {}],
      ["/favicon.ico", {}],
      ["/robots.txt", {}],
      ["/script", { headers: { "sec-fetch-dest": "script" } }],
      ["/prefetch", { headers: { purpose: "prefetch" } }],
      ["/head", { method: "HEAD" }],
      ["/json", { headers: { accept: "application/json" } }],
      ["/post", { method: "POST", headers, body: "{}" }],
      ["/bad%2fpath", {}],
    ] as const;
    for (const [url, options] of rejected)
      assert.ok((await fetch(origin + url, options)).status >= 400, url);
    assert.equal((await automatic.list()).length, 1);
    assert.equal(
      (await fetch(origin + "/", { redirect: "manual" })).headers.get(
        "location",
      ),
      "/_harness/",
    );
    const backend = await fetch(origin + "/_settings");
    assert.equal(backend.headers.get("referrer-policy"), "no-referrer");
    const settings = await (await fetch(origin + "/api/settings")).json();
    assert.doesNotMatch(JSON.stringify(settings), /offline-test-key/);
    assert.equal(
      (
        await fetch(origin + "/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(settings),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${origin}/api/automatic/${id}/retry`, {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      202,
    );
    assert.equal(
      (await automatic.list()).length,
      1,
      "Retry of success must not generate again",
    );
  } finally {
    await automatic.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("reference resolution is deterministic and pins exact referring, archive, and preview versions", () => {
  const page = (path: string, id: string): Session => ({
    id,
    path,
    currentVersion: `${id}-v2`,
    versions: [`${id}-v1`, `${id}-v2`],
    model: "openai/gpt-5.6-luna",
    effort: "high",
    description: "",
    createdAt: "",
    runs: [],
    messages: [],
  });
  const a = page("/site/a", "a"),
    b = page("/site/b", "b"),
    other = page("/other", "other");
  const archived = {
    ...page("/archive", "old"),
    archived: {
      at: "",
      versionId: "old-v1",
      url: "/_archive/old/old-v1/archive",
    },
  };
  const sessions = [b, other, archived, a];
  const select = (url: string | null, target = "/site/new") =>
    selectReference(sessions, target, url, 8787);
  assert.equal(select(null).reference?.sessionId, "a");
  assert.equal(select(null, "/empty/new").reference?.sessionId, "other");
  assert.equal(
    select("https://external.example/site/b").reference?.sessionId,
    "a",
  );
  assert.equal(
    select("http://127.0.0.1:8787/site/b").reference?.versionId,
    "b-v2",
  );
  assert.equal(
    select("http://localhost:8787/api/preview/b/b-v1").reference?.versionId,
    "b-v1",
  );
  assert.equal(
    select("http://127.0.0.1:8787/_archive/old/old-v1/archive").reference
      ?.versionId,
    "old-v1",
  );
  assert.equal(selectReference([], "/new", null, 8787).reference, null);
});

test("live settings persist and snapshot both stages without affecting manual runs", async () => {
  const started = gate(),
    finish = gate();
  const configs: { assets: string; maxSteps: number; model: string }[] = [];
  const { automatic, harness, config } = await setup(
    async (request) => {
      configs.push({
        assets: request.config.assets,
        maxSteps: request.config.maxSteps,
        model: request.model,
      });
      return output();
    },
    async (effective) => {
      assert.equal(effective.maxSteps, 3);
      started.release();
      await finish.promise;
      return brief;
    },
  );
  await change(automatic, { maxSteps: 3, assets: "generated" });
  const first = await automatic.ensure("/snapshot", null);
  await started.promise;
  await change(automatic, {
    maxSteps: 6,
    descriptionEnabled: false,
    assets: "openverse",
  });
  finish.release();
  assert.equal((await automatic.wait(first!.id)).status, "success");
  const second = await automatic.ensure("/second", null);
  await automatic.wait(second!.id);
  const manual = await harness.create({ path: "/manual", model: 1 });
  await harness.wait(manual.run.id);
  assert.deepEqual(
    configs.map((c) => [c.assets, c.maxSteps]),
    [
      ["generated", 3],
      ["openverse", 6],
      ["none", config.maxSteps],
    ],
  );
  assert.equal(configs[2].model, "anthropic/claude-opus-5");
  const persisted = new Settings(config);
  assert.equal((await persisted.get()).settings.maxSteps, 6);
  const stale = await persisted.get();
  await change(automatic, { maxSteps: 7 });
  await assert.rejects(() => persisted.save(stale), /changed/);
  await assert.rejects(() =>
    change(automatic, { populationSearchResults: 26 }),
  );
  assert.equal(
    (await persisted.get()).settings.populationSearchResults,
    config.populationSearchResults,
  );
  const runInput = JSON.parse(
    await readFile(
      harness.store.file("runs", first!.runId!, "input.json"),
      "utf8",
    ),
  );
  assert.equal(runInput.config.maxSteps, 3);
  await change(automatic, { enabled: false });
  assert.equal(await automatic.ensure("/disabled", null), null);
});

test("population off/failure and rejected external references continue with ordinary generation", async () => {
  let calls = 0;
  const { automatic, harness } = await setup(
    async () => output(),
    async () => {
      calls++;
      throw new Error("population fixture failure");
    },
  );
  const failedPopulation = await automatic.ensure("/fallback", null);
  const record = await automatic.wait(failedPopulation!.id);
  assert.equal(record.status, "success");
  assert.match(record.warnings.join(), /population fixture failure/);
  assert.equal(
    (await harness.store.session(record.sessionId!)).populatedBrief,
    "",
  );
  assert.equal(
    (await harness.populations.get(record.populationId!)).status,
    "failed",
  );
  await change(automatic, { descriptionEnabled: false });
  const skipped = await automatic.ensure("/skipped", null);
  await automatic.wait(skipped!.id);
  assert.equal(calls, 1);
  assert.equal(skipped!.populationId, undefined);
  const other = await setup(
    async () => output(),
    async () => ({
      ...brief,
      externalReferences: [
        {
          url: "http://localhost:8787/private",
          reason: "fixture",
          provenance: "fixture",
        },
      ],
    }),
  );
  const omitted = await other.automatic.ensure("/omitted", null);
  await other.automatic.wait(omitted!.id);
  assert.equal(omitted!.status, "success", omitted!.error);
  assert.match(omitted!.warnings.join(), /External reference omitted/);
});

test("website failures require explicit retry, reuse session, preserve traces and recover restart", async () => {
  let calls = 0;
  const { automatic, harness } = await setup(async () => {
    if (++calls === 1) throw new Error("fixture failure");
    return output();
  });
  await change(automatic, { descriptionEnabled: false });
  const attempt = await automatic.ensure("/retry", null);
  await automatic.wait(attempt!.id);
  assert.equal(attempt!.status, "failed");
  assert.equal((await automatic.ensure("/retry", null))!.id, attempt!.id);
  const retried = await automatic.ensure("/retry", null, attempt!.id);
  await automatic.wait(retried!.id);
  assert.equal(retried!.status, "success", retried!.error);
  assert.equal(retried!.sessionId, attempt!.sessionId);
  assert.equal(
    (await harness.store.session(retried!.sessionId!)).runs.length,
    2,
  );
  assert.equal((await harness.store.run(attempt!.runId!)).status, "failed");
  const interrupted = {
    ...attempt!,
    id: "interrupted",
    path: "/interrupted",
    status: "running",
    startedAt: new Date().toISOString(),
  };
  await atomicWrite(
    harness.store.file("automatic", interrupted.id),
    JSON.stringify(interrupted),
  );
  const reopened = new AutomaticPages(harness);
  assert.equal((await reopened.get(interrupted.id)).status, "failed");
  assert.equal(
    (await reopened.ensure("/interrupted", null))!.id,
    interrupted.id,
  );
  const session = await harness.store.session(retried!.sessionId!);
  await harness.archive(session.id, session.currentVersion!);
  const replacement = await automatic.ensure("/retry", null);
  await automatic.wait(replacement!.id);
  assert.equal(replacement!.status, "success");
  assert.notEqual(replacement!.sessionId, session.id);
});

test("manual creation races share the run; automatic population reserves its URL", async () => {
  const started = gate(),
    finish = gate();
  const { automatic, harness } = await setup(async () => {
    started.release();
    await finish.promise;
    return output();
  });
  const creation = harness.create({ path: "/race", model: 1 });
  const attempt = await automatic.ensure("/race", null);
  await started.promise;
  finish.release();
  const manual = await creation;
  await automatic.wait(attempt!.id);
  assert.equal(attempt!.sessionId, manual.session.id);
  assert.equal((await harness.store.sessions()).length, 1);
  const populationStarted = gate(),
    populationFinish = gate();
  const other = await setup(
    async () => output(),
    async () => {
      populationStarted.release();
      await populationFinish.promise;
      return brief;
    },
  );
  const reserved = await other.automatic.ensure("/reserved", null);
  await populationStarted.promise;
  await assert.rejects(
    () => other.harness.create({ path: "/reserved", model: 1 }),
    /being created/,
  );
  populationFinish.release();
  await other.automatic.wait(reserved!.id);
  assert.equal(reserved!.status, "success");
});

test("cancelling a website run leaves a failed attempt until explicit retry", async () => {
  const started = gate();
  const { automatic, harness } = await setup(async (request) => {
    started.release();
    await new Promise<void>((_, reject) => {
      request.signal.addEventListener(
        "abort",
        () => reject(request.signal.reason),
        { once: true },
      );
    });
    return output();
  });
  await change(automatic, { descriptionEnabled: false });
  const attempt = await automatic.ensure("/cancel", null);
  await started.promise;
  const active = [...harness.active.values()][0];
  harness.cancel(active.runId);
  await automatic.wait(attempt!.id);
  assert.equal(attempt!.status, "failed");
  assert.equal((await harness.store.run(active.runId)).status, "cancelled");
  assert.equal((await automatic.ensure("/cancel", null))!.id, attempt!.id);
});

test("shutdown during population stops before website generation", async () => {
  const started = gate();
  let websiteCalls = 0;
  const { automatic } = await setup(
    async () => {
      websiteCalls++;
      return output();
    },
    async (_config, _record, signal) => {
      started.release();
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
      });
      return brief;
    },
  );
  const attempt = await automatic.ensure("/shutdown", null);
  await started.promise;
  await automatic.close();
  assert.equal(attempt!.status, "failed");
  assert.equal(websiteCalls, 0);
});

test("released URL regenerates on GET when enabled; disabled generation returns unavailable", async () => {
  let calls = 0;
  const { harness, automatic, config } = await setup(async () => {
    calls++;
    return output();
  });
  await change(automatic, { descriptionEnabled: false });
  const original = await automatic.ensure("/released", null);
  await automatic.wait(original!.id);
  const session = await harness.store.session(original!.sessionId!);
  const archived = await harness.archive(session.id, session.currentVersion!);
  assert.equal(await harness.store.byPath("/released"), undefined);

  const server = createHttpServer(harness, automatic);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  config.port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${config.port}`;
  try {
    await change(automatic, { enabled: false });
    const disabled = await fetch(origin + "/released");
    assert.equal(disabled.status, 503);
    assert.match(await disabled.text(), /Unable to load this page/);
    assert.equal(calls, 1);
    assert.equal((await automatic.list()).length, 1);

    await change(automatic, { enabled: true });
    const revisit = await fetch(origin + "/released");
    assert.equal(revisit.status, 200);
    const html = await revisit.text();
    assert.match(html, /Loading…/);
    const id = /data-attempt="([\w-]+)"/.exec(html)![1];
    assert.notEqual(id, original!.id);
    const replacement = await automatic.wait(id);
    assert.equal(replacement.status, "success", replacement.error);
    assert.notEqual(replacement.sessionId, session.id);
    assert.equal(calls, 2);
    assert.match(
      await (await fetch(origin + "/released")).text(),
      /A tiny museum/,
    );
    assert.match(
      await (await fetch(origin + archived.archived!.url)).text(),
      /A tiny museum/,
    );
    assert.equal(calls, 2, "Published and archived pages must not regenerate");
  } finally {
    await automatic.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
