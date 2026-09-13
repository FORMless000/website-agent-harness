import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInteractionDriver,
  transitionSchema,
} from "../src/interaction-agent.js";
import { mockTransport, testConfig } from "./fixtures.js";

const transition = {
  html: '<button data-region-action="next">Next</button>',
  css: null,
  state: { step: 1, complete: false },
  destinations: [{ path: "/next", description: "The next region" }],
};
const submit = (value: unknown, id = "call-1") => ({
  type: "function_call",
  name: "submit_region",
  arguments: JSON.stringify(value),
  call_id: id,
  id: `tool-${id}`,
  status: "completed",
});

async function run(
  outputs: unknown[][],
  context: unknown = { purpose: "advance", action: "click next" },
) {
  const config = await testConfig();
  const requests: Record<string, any>[] = [];
  const events: { type: string; data: unknown }[] = [];
  const result = await createInteractionDriver(
    mockTransport(outputs, requests),
  )({
    config,
    model: "deepseek/deepseek-v4.1-flash",
    effort: "low",
    instructions: "Update only the supplied region and submit it.",
    context,
    signal: new AbortController().signal,
    emit: async (type, data) => {
      events.push({ type, data });
    },
    validate: (value) => transitionSchema.parse(value),
  });
  return { result, requests, events };
}

test("interaction accepts one region call without an extra model request", async () => {
  const { result, requests, events } = await run([[submit(transition)]]);
  assert.deepEqual(result, transition);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, "deepseek/deepseek-v4.1-flash");
  assert.equal(requests[0].reasoning.effort, "low");
  assert.ok(events.some((event) => event.type === "usage"));
});

test("interaction retries with validation feedback", async () => {
  const invalid = {
    ...transition,
    destinations: [{ path: "/_settings", description: "bad" }],
  };
  const { result, requests, events } = await run([
    [submit(invalid, "bad")],
    [submit(transition, "good")],
  ]);
  assert.deepEqual(result, transition);
  assert.equal(requests.length, 2);
  const decisions = events.filter(
    (event) => event.type === "interaction.decision",
  );
  assert.equal(decisions.length, 2);
  assert.equal((decisions[0].data as { accepted: boolean }).accepted, false);
  assert.equal((decisions[1].data as { accepted: boolean }).accepted, true);
});

test("interaction sends the complete prior context once and no page context", async () => {
  const context = {
    purpose: "counter",
    current: { html: "<p>0</p>", css: null, state: { count: 0 } },
    history: [{ action: "increment", state: { count: 0 } }],
  };
  const { requests } = await run([[submit(transition)]], context);
  assert.deepEqual(JSON.parse(requests[0].input), context);
  assert.equal(requests[1], undefined);
  assert.doesNotMatch(
    JSON.stringify(requests[0].input),
    /pageContext|page context/i,
  );
});
