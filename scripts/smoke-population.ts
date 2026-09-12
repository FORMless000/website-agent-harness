// Explicitly paid population-only experiment. Never creates website sessions.
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { Store, atomicWrite } from "../src/store.js";
import { Prompts } from "../src/prompts.js";
import { Populations } from "../src/population.js";
if (!process.argv.includes("--confirm-paid"))
  throw new Error(
    "Pass --confirm-paid to authorize three population attempts (up to three model requests and one search each).",
  );
const config = loadConfig({
  maxSteps: 3,
  populationSearches: 1,
  populationSearchResults: 3,
  timeoutMs: 120000,
});
const store = new Store(config.dataDir);
const populations = new Populations(config, store, new Prompts(config.root));
const parent = (await store.sessions()).find(
  (s) => s.path === "/wiki/trinity" && s.currentVersion,
);
const cases = [
  {
    path: "/wiki/scallion",
    description: "",
    internalReference: parent
      ? { sessionId: parent.id, versionId: parent.currentVersion! }
      : null,
  },
  {
    path: "/orbital-lost-and-found",
    description:
      "A fictional lost-and-found office for misplaced moons. Use a playful purple design. Do not search the web or propose external references.",
    internalReference: null,
  },
  {
    path: "/field-guide/bioluminescent-fungi",
    description:
      "A factual introductory field guide. Search for one useful authoritative external reference.",
    internalReference: null,
  },
];
const results = [];
for (const input of cases) {
  const started = await populations.start({
    ...input,
    model: "openai/gpt-5.6-luna",
    effort: "low",
    allowReferenceSuggestions: false,
  });
  while (populations.active.has(started.id))
    await new Promise((r) => setTimeout(r, 250));
  const record = await populations.get(started.id);
  const events = await populations.events(started.id);
  const summary = {
    path: input.path,
    id: record.id,
    status: record.status,
    seconds:
      (Date.parse(record.finishedAt!) - Date.parse(record.startedAt)) / 1000,
    requests: events.filter((e) => e.type === "request").length,
    result: record.result,
    error: record.error,
    usage: events.filter((e) => e.type === "usage").map((e) => e.data),
  };
  results.push(summary);
  console.log(JSON.stringify(summary));
}
const report = path.join(
  config.dataDir,
  "reports",
  `population-smoke-${Date.now()}.json`,
);
await atomicWrite(
  report,
  JSON.stringify(
    {
      model: "openai/gpt-5.6-luna",
      effort: "low",
      maxRequestsPerCase: 3,
      maxSearchesPerCase: 1,
      results,
    },
    null,
    2,
  ),
);
console.log(`Report: ${report}`);
