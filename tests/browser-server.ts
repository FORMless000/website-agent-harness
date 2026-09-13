// Test-only entry point: never imported by the real server or CLI.
import { Harness } from "../src/harness.js";
import { serve } from "../src/server.js";
import { createDriver } from "../src/agent.js";
import type { InteractionDriver } from "../src/interaction-agent.js";
import {
  artifact,
  catalog,
  testConfig,
  mockTransport,
  submission,
  reasoning,
} from "./fixtures.js";

function browserRegionsArtifact() {
  const page = artifact("Browser regions");
  page.html = page.html.replace(
    "</body>",
    '<section aria-label="Search"><div data-region-id="search"></div></section><section aria-label="Local counter"><div data-region-id="local"></div></section></body>',
  );
  page.regions = [
    {
      id: "search",
      purpose: "Search the museum",
      html: '<form data-region-action="search"><label>Search <input name="q" data-region-action="search" data-region-event="input" value=""></label><button type="submit" data-region-action="search" name="submit">Search</button><p data-testid="search-result">Ready</p></form>',
      css: null,
      state: { query: "" },
      javascript: null,
    },
    {
      id: "local",
      purpose: "A local counter",
      html: '<button data-region-action="increment" name="increment">Increment</button><button data-region-action="fail" name="fail">Fail</button><a href="/browser-auto/region-result">Open result</a><p data-testid="count">0</p><p data-testid="init">0</p>',
      css: null,
      state: { count: 0, init: 0 },
      javascript:
        'globalThis.__regionInit=(globalThis.__regionInit||0)+1; region.setState({...region.state,init:globalThis.__regionInit}); region.root.querySelector("[data-testid=init]").textContent=String(region.state.init); region.onUpdate(state=>{const node=region.root.querySelector("[data-testid=init]"); if(node) node.textContent=String(state.init);});',
    },
  ];
  return page;
}
const config = await testConfig();
config.port = 18788;
const fetcher = mockTransport([
  [reasoning, submission(artifact())],
  [submission(artifact("A smaller, stranger museum"), "edit")],
  [submission(artifact("Mobile museum"), "mobile")],
]);
const manualDriver = createDriver(fetcher);
const automaticCalls = new Map<string, number>();
let failureCalls = 0;
const server = await serve(
  new Harness(
    config,
    async (request) => {
      const target =
        typeof request.input === "string"
          ? JSON.parse(request.input).subUrl
          : /Target sub-URL: ([^\n]+)/.exec(
              request.input.at(-1)?.content.at(-1)?.text ?? "",
            )?.[1];
      if (target?.startsWith("/browser-regions")) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          artifact: browserRegionsArtifact(),
          staged: [],
          text: "Offline browser regions fixture",
          pageDescription:
            "Interactive browser fixture with search and counter regions.",
        };
      }
      if (!target?.startsWith("/browser-auto")) return manualDriver(request);
      const count = (automaticCalls.get(target) ?? 0) + 1;
      automaticCalls.set(target, count);
      if (target === "/browser-auto/progress") {
        await request.emit("provider.event", {
          type: "response.reasoning_text.delta",
          delta: "private reasoning fixture",
        });
        await new Promise((resolve) => setTimeout(resolve, 1800));
        await request.emit("provider.event", {
          type: "response.output_item.added",
          item: { type: "function_call", name: "submit_website" },
        });
        await new Promise((resolve) => setTimeout(resolve, 1800));
      } else await new Promise((resolve) => setTimeout(resolve, 800));
      if (target === "/browser-auto/failure" && count === 1)
        throw new Error("Offline browser failure fixture");
      const page = artifact(`Automatic ${target}`);
      page.html = page.html.replace(
        "</body>",
        '<a href="/browser-auto/child">Explore child</a><a href="/browser-auto/preview">Explore preview child</a><a href="/browser-auto/archive-child">Explore archive child</a></body>',
      );
      return {
        artifact: page,
        staged: [],
        text: "Offline automatic fixture",
        pageDescription: "Automatic navigation fixture",
      };
    },
    async () => catalog,
    async (_config, record, signal, emit) => {
      await emit("request", { body: { input: record.context } });
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          record.input.path === "/browser-auto/progress" ? 1800 : 150,
        ),
      );
      signal.throwIfAborted();
      await emit("usage", { inputTokens: 100, outputTokens: 40 });
      return {
        brief: "A playful fixture brief.",
        similarity: "insufficient_evidence",
        rationale: "Fixture evidence",
        relevantNeighbors: [],
        externalReferences: record.input.path.startsWith("/browser-auto")
          ? []
          : [
              {
                url: "https://example.org/reference",
                reason: "Fixture reference",
                provenance: "Mocked search",
              },
            ],
        referenceRecommendation: {
          action: record.input.allowReferenceSuggestions ? "clear" : "retain",
          reference: null,
          rationale: "Fixture choice",
        },
        warnings: [],
      };
    },
  ),
  (async (request) => {
    const context = request.context as any;
    const action = context.event.action;
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (action === "fail" && ++failureCalls % 2 === 1) {
      throw new Error("Offline interaction failure fixture");
    }
    if (action === "search") {
      const query = String(context.event.inputs.q ?? "");
      return {
        html: `<form data-region-action="search"><label>Search <input name="q" data-region-action="search" data-region-event="input" value="${query.replace(/"/g, "&quot;")}"></label><button type="submit" data-region-action="search" name="submit">Search</button><p data-testid="search-result">Results for ${query}</p></form>`,
        css: null,
        state: { query },
        destinations: [],
      };
    }
    const count =
      Number(context.event.state.count ?? 0) + (action === "increment" ? 1 : 0);
    return {
      html: `<button data-region-action="increment" name="increment">Increment</button><button data-region-action="fail" name="fail">Fail</button><a href="/browser-auto/region-result">Open result</a><p data-testid="count">${count}</p><p data-testid="init">${Number(context.event.state.init ?? 0)}</p>`,
      css: null,
      state: { ...context.event.state, count },
      destinations: [
        {
          path: "/browser-auto/region-result",
          description: "Generated region result",
        },
      ],
    };
  }) as InteractionDriver,
);
process.on("SIGTERM", () => void server.close());
process.on("SIGINT", () => void server.close());
console.log("Offline browser fixture ready on port 18788");
