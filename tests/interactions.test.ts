import { test } from "node:test";
import assert from "node:assert/strict";
import { Harness } from "../src/harness.js";
import { Interactions, StaleInteraction } from "../src/interactions.js";
import type { InteractionDriver } from "../src/interaction-agent.js";
import type { Artifact } from "../src/contracts.js";
import { validateArtifact } from "../src/validation.js";
import { artifact, catalog, testConfig } from "./fixtures.js";
import { Settings } from "../src/settings.js";
import { atomicWrite } from "../src/store.js";
import path from "node:path";

function pageArtifact(includeSibling = false): Artifact {
  const base = artifact("Interactive museum");
  return {
    ...base,
    html: base.html.replace(
      "</main>",
      `<div data-region-id="counter"></div>${includeSibling ? '<div data-region-id="profile"></div>' : ""}</main>`,
    ),
    regions: [
      {
        id: "counter",
        purpose: "Increment the displayed count.",
        html: '<button data-region-action="increment" name="increment">Add</button><p class="count">0</p>',
        css: null,
        state: { count: 0 },
        javascript: "region.onUpdate(() => {});",
      },
      ...(includeSibling
        ? [
            {
              id: "profile",
              purpose: "Show the visitor profile.",
              html: '<p data-region-action="profile">Guest</p>',
              css: null,
              state: { name: "Guest" },
              javascript: null,
            },
          ]
        : []),
    ],
  };
}

async function setup(
  driver: InteractionDriver = async ({ context }) =>
    ({
      html: '<button data-region-action="increment" name="increment">Add</button><p class="count">1</p>',
      css: null,
      state: { count: Number((context as any).event.state.count) + 1 },
      destinations: [],
    }) as any,
  includeSibling = false,
  generationInputs: any[] = [],
  settingsPatch: Record<string, unknown> = {},
) {
  const config = await testConfig();
  let generationCalls = 0;
  const harness = new Harness(
    config,
    async (input) => {
      generationCalls++;
      generationInputs.push(input);
      return {
        artifact: pageArtifact(includeSibling),
        staged: [],
        text: "Fixture",
        pageDescription: "Interactive museum fixture.",
      };
    },
    async () => catalog,
  );
  if (Object.keys(settingsPatch).length) {
    const defaults = (await new Settings(config).get()).settings;
    await atomicWrite(
      path.join(config.dataDir, "automatic-settings.json"),
      JSON.stringify({ ...defaults, ...settingsPatch }),
    );
  }
  const created = await harness.create({ path: "/interactive", model: 1 });
  await harness.wait(created.run.id);
  const session = await harness.store.session(created.session.id);
  const version = await harness.store.version(
    session.id,
    session.currentVersion!,
  );
  const interactions = new Interactions(harness, driver);
  return { harness, interactions, session, version, generationCalls };
}

const event = (count = 0, action = "increment") => ({
  revision: count,
  event: { action, inputs: {}, state: { count } },
});

test("visits start at revision zero without an initial interaction model call", async () => {
  let calls = 0;
  const { interactions, session, version, generationCalls } = await setup(
    async () => {
      calls++;
      return { html: "<p>updated</p>", css: null, state: {}, destinations: [] };
    },
  );
  assert.equal(generationCalls, 1);
  const first = await interactions.create(session.id, session.path, version);
  assert.equal(calls, 0);
  const current = await interactions.get(first.visitId, "counter");
  assert.equal(current.current.revision, 0);
  assert.deepEqual(current.current.state, { count: 0 });
});

test("legacy saved settings receive interaction defaults", async () => {
  const config = await testConfig();
  const defaults = (await new Settings(config).get()).settings;
  const {
    interactionModel,
    interactionEffort,
    interactionJavascript,
    ...legacy
  } = defaults;
  await atomicWrite(
    path.join(config.dataDir, "automatic-settings.json"),
    JSON.stringify(legacy),
  );
  const loaded = (await new Settings(config).get()).settings;
  assert.equal(loaded.interactionModel, interactionModel);
  assert.equal(loaded.interactionEffort, interactionEffort);
  assert.equal(loaded.interactionJavascript, interactionJavascript);
});

test("each visit snapshots interaction model and effort settings", async () => {
  const calls: { model: string; effort: string }[] = [];
  const { interactions, session, version } = await setup(
    async (input) => {
      calls.push({ model: input.model, effort: input.effort });
      return {
        html: "<p>updated</p>",
        css: null,
        state: { count: 1 },
        destinations: [],
      };
    },
    false,
    [],
    { interactionModel: catalog[1].id, interactionEffort: "high" },
  );
  const visit = await interactions.create(session.id, session.path, version);
  await interactions.transition(visit.visitId, "counter", event());
  assert.deepEqual(calls, [{ model: catalog[1].id, effort: "high" }]);
});

test("generation prompt records the JavaScript preference and regions retain separate JavaScript", async () => {
  const inputs: any[] = [];
  const { harness } = await setup(undefined, true, inputs, {
    interactionJavascript: true,
  });
  assert.match(
    inputs[0].instructions,
    /Interaction JavaScript preference: enabled/,
  );
  const session = await harness.store
    .sessions()
    .then((sessions) => sessions[0]);
  const version = await harness.store.version(
    session.id,
    session.currentVersion!,
  );
  assert.equal(
    version.artifact.regions?.find((r) => r.id === "counter")?.javascript,
    "region.onUpdate(() => {});",
  );
  assert.equal(
    version.artifact.regions?.find((r) => r.id === "profile")?.javascript,
    null,
  );
});

test("sibling visits have independent minimal histories and use saved interaction settings", async () => {
  const contexts: any[] = [];
  const { interactions, session, version } = await setup(async (input) => {
    contexts.push(input.context);
    return {
      html: "<p>updated</p>",
      css: null,
      state: { count: 1 },
      destinations: [],
    };
  });
  const a = await interactions.create(session.id, session.path, version);
  const b = await interactions.create(session.id, session.path, version);
  await interactions.transition(a.visitId, "counter", event());
  assert.equal(
    (await interactions.get(b.visitId, "counter")).current.revision,
    0,
  );
  await interactions.transition(b.visitId, "counter", event());
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].history.length, 1);
  assert.equal(contexts[0].purpose, "Increment the displayed count.");
  assert.equal(contexts[0].javascript, "region.onUpdate(() => {});");
  assert.equal(
    contexts[0].history[0].html.includes("Interactive museum"),
    false,
  );
});

test("sibling region histories stay independent and omit each other's purpose", async () => {
  const contexts: any[] = [];
  const { interactions, session, version } = await setup(async (input) => {
    contexts.push(input.context);
    return {
      html: "<p>updated</p>",
      css: null,
      state: { count: 1 },
      destinations: [],
    };
  }, true);
  const visit = await interactions.create(session.id, session.path, version);
  await interactions.transition(visit.visitId, "counter", event());
  await interactions.transition(visit.visitId, "profile", {
    revision: 0,
    event: { action: "profile", inputs: {}, state: { name: "Guest" } },
  });
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].history[0].revision, 0);
  assert.equal(contexts[1].history[0].revision, 0);
  assert.equal(contexts[0].purpose, "Increment the displayed count.");
  assert.equal(contexts[1].purpose, "Show the visitor profile.");
  assert.doesNotMatch(JSON.stringify(contexts[0]), /Show the visitor profile/);
  assert.doesNotMatch(
    JSON.stringify(contexts[1]),
    /Increment the displayed count/,
  );
});

test("stale and concurrent transitions are rejected without extra model calls", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { interactions, session, version } = await setup(async () => {
    calls++;
    await gate;
    return {
      html: "<p>updated</p>",
      css: null,
      state: { count: 1 },
      destinations: [],
    };
  });
  const visit = await interactions.create(session.id, session.path, version);
  const running = interactions.transition(visit.visitId, "counter", event());
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(
    () => interactions.transition(visit.visitId, "counter", event()),
    StaleInteraction,
  );
  assert.equal(calls, 1);
  release();
  await running;
  await assert.rejects(
    () => interactions.transition(visit.visitId, "counter", event(0)),
    StaleInteraction,
  );
  assert.equal(calls, 1);
});

test("failed transitions preserve the old history and definition javascript", async () => {
  const seen: any[] = [];
  const { interactions, session, version } = await setup(async (input) => {
    seen.push(input.context);
    throw new Error("provider failed");
  });
  const visit = await interactions.create(session.id, session.path, version);
  await assert.rejects(
    () => interactions.transition(visit.visitId, "counter", event()),
    /provider failed/,
  );
  const current = await interactions.get(visit.visitId, "counter");
  assert.equal(current.history.revisions.length, 1);
  assert.equal(seen[0].javascript, "region.onUpdate(() => {});");
});

test("declared destinations are navigable and unapproved destinations are rejected", async () => {
  const { interactions, session, version } = await setup(async () => ({
    html: '<a href="/child">Open child</a>',
    css: null,
    state: { count: 1 },
    destinations: [{ path: "/child", description: "The child page." }],
  }));
  const visit = await interactions.create(session.id, session.path, version);
  await interactions.transition(visit.visitId, "counter", event());
  const destination = await interactions.navigation(visit.visitId, "counter", {
    path: "/child",
  });
  assert.equal(destination.description, "The child page.");
  await assert.rejects(
    () =>
      interactions.navigation(visit.visitId, "counter", { path: "/secret" }),
    /not declared/,
  );
  await assert.rejects(() =>
    interactions.navigation(visit.visitId, "counter", { path: "/api/private" }),
  );
});

test("artifact validation enforces unique, empty, non-nested placeholders while allowing region javascript", () => {
  const valid = pageArtifact();
  assert.deepEqual(validateArtifact(valid, []).errors, []);
  assert.ok(
    validateArtifact(
      {
        ...valid,
        html: valid.html.replace(
          'data-region-id="counter"></div>',
          'data-region-id="counter"><span>x</span></div>',
        ),
      },
      [],
    ).errors.length,
  );
  assert.ok(
    validateArtifact(
      {
        ...valid,
        html: valid.html.replace(
          'data-region-id="counter"',
          'data-region-id="other"',
        ),
      },
      [],
    ).errors.length,
  );
  assert.ok(
    validateArtifact(
      {
        ...valid,
        html: valid.html.replace(
          "</main>",
          '<div data-region-id="counter"></div></main>',
        ),
      },
      [],
    ).errors.length,
  );
  assert.ok(
    validateArtifact(
      {
        ...valid,
        regions: [
          { ...valid.regions![0], html: '<div data-region-id="nested"></div>' },
        ],
      },
      [],
    ).errors.length,
  );
  assert.ok(
    validateArtifact(
      {
        ...valid,
        regions: [{ ...valid.regions![0], html: "<script>x()</script>" }],
      },
      [],
    ).errors.length,
  );
  assert.equal(
    validateArtifact(valid, []).errors.some((e) => /javascript/.test(e)),
    false,
  );
});
