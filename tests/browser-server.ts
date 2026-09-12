// Test-only entry point: never imported by the real server or CLI.
import { Harness } from "../src/harness.js";
import { serve } from "../src/server.js";
import { createDriver } from "../src/agent.js";
import {
  artifact,
  catalog,
  testConfig,
  mockTransport,
  submission,
  reasoning,
} from "./fixtures.js";
const config = await testConfig();
config.port = 18788;
const fetcher = mockTransport([
  [reasoning, submission(artifact())],
  [submission(artifact("A smaller, stranger museum"), "edit")],
  [submission(artifact("Mobile museum"), "mobile")],
]);
const manualDriver = createDriver(fetcher);
const automaticCalls = new Map<string, number>();
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
);
process.on("SIGTERM", () => void server.close());
process.on("SIGINT", () => void server.close());
console.log("Offline browser fixture ready on port 18788");
