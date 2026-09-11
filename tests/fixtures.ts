import { mkdtemp, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Fetcher } from "@openrouter/sdk/lib/http";
import { loadConfig, ROOT } from "../src/config.js";
import { MODEL_REGISTRY, type Capability } from "../src/models.js";
import type { Artifact } from "../src/contracts.js";

export const artifact = (title = "A tiny museum"): Artifact => ({
  schemaVersion: 1,
  html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><main><p class="eyebrow">A COLLECTION OF EVERYDAY WONDERS</p><h1>${title}</h1><p>Small objects. Extraordinary stories.</p><div class="cards"><article><h2>01 / A blue button</h2><p>Found at the edge of a very ordinary Tuesday.</p></article><article><h2>02 / A folded note</h2><p>A message that waited to be discovered.</p></article><article><h2>03 / A smooth stone</h2><p>One thousand tides in the palm of your hand.</p></article></div><details><summary>About this collection</summary><p>This is an offline test fixture, not an LLM-generated result.</p></details></main></body></html>`,
  css: "body{margin:0;background:#f3ede3;color:#342c24;font-family:Georgia,serif}main{max-width:900px;margin:auto;padding:60px 30px}.eyebrow{font:10px sans-serif;letter-spacing:2px;color:#a56236}h1{font-size:clamp(36px,6vw,68px);font-weight:400}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:20px;margin:40px 0}article{border-top:1px solid #c7bba7;padding:18px 0}article h2{font-size:17px}article p{line-height:1.7;color:#776753}details{border-top:1px solid #c7bba7;padding-top:20px}",
});
export const catalog: Capability[] = MODEL_REGISTRY.map((m) => ({
  id: m.id,
  context_length: 100000,
  supported_parameters: [
    "tools",
    "tool_choice",
    "reasoning",
    "structured_outputs",
  ],
  reasoning: { supported_efforts: ["low", "high", "max"] },
  pricing: { prompt: "0", completion: "0" },
}));
export async function testConfig() {
  const root = await mkdtemp(path.join(tmpdir(), "vibenet-test-"));
  await Promise.all(
    ["prompts", "web"].map((dir) =>
      cp(path.join(ROOT, dir), path.join(root, dir), { recursive: true }),
    ),
  );
  return loadConfig({
    root,
    dataDir: path.join(root, "data"),
    apiKey: "offline-test-key",
    assets: "none",
    port: 18787,
    timeoutMs: 10000,
  });
}
export const reasoning = {
  type: "reasoning",
  id: "reasoning-fixture",
  summary: [
    {
      type: "summary_text",
      text: "I will arrange the collection in a responsive grid.",
    },
  ],
  encrypted_content: "opaque-test-value",
  status: "completed",
};
export function mockResponse(output: unknown[], id: string) {
  return {
    id,
    object: "response",
    created_at: 1,
    completed_at: 2,
    status: "completed",
    model: MODEL_REGISTRY[0].id,
    output,
    error: null,
    incomplete_details: null,
    instructions: null,
    frequency_penalty: null,
    presence_penalty: null,
    metadata: null,
    parallel_tool_calls: false,
    temperature: null,
    top_p: null,
    tool_choice: "auto",
    tools: [],
    usage: {
      input_tokens: 20,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 30,
      output_tokens_details: { reasoning_tokens: 10 },
      total_tokens: 50,
      cost: 0.001,
    },
  };
}
export function mockTransport(
  outputs: unknown[][],
  requests: Record<string, unknown>[] = [],
): Fetcher {
  let count = 0;
  return async (input, init) => {
    const request = new Request(input, init);
    requests.push(JSON.parse(await request.text()));
    if (count >= outputs.length)
      throw new Error("Unexpected extra model request.");
    const output = outputs[count]!;
    const response = mockResponse(output, `response-${++count}`);
    const events = [
      ...output.map((item, index) => ({
        type: "response.output_item.done",
        item,
        output_index: index,
        sequence_number: index,
      })),
      { type: "response.completed", response, sequence_number: output.length },
    ];
    return new Response(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
}
export const submission = (value: unknown, id = "call-1") => ({
  type: "function_call",
  name: "submit_website",
  arguments: JSON.stringify(value),
  call_id: id,
  id: `tool-${id}`,
  status: "completed",
});
