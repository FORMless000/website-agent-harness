import { z } from "zod";

export const MODEL_REGISTRY = [
  { number: 1, label: "Claude Opus 5", id: "anthropic/claude-opus-5" },
  { number: 2, label: "GPT-5.6 Sol", id: "openai/gpt-5.6-sol" },
  { number: 3, label: "GPT-5.6 Luna", id: "openai/gpt-5.6-luna" },
  { number: 4, label: "GLM 5.3", id: "z-ai/glm-5.3" },
  {
    number: 5,
    label: "DeepSeek V4 Pro 0813",
    id: "deepseek/deepseek-v4-pro-0813",
  },
  {
    number: 6,
    label: "DeepSeek V4.1 Flash",
    id: "deepseek/deepseek-v4.1-flash",
  },
] as const;
export const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof effortSchema>;
const capabilitySchema = z
  .object({
    id: z.string(),
    canonical_slug: z.string().optional(),
    context_length: z.number(),
    supported_parameters: z.array(z.string()),
    pricing: z.record(z.string(), z.unknown()).optional(),
    reasoning: z
      .object({
        supported_efforts: z.array(z.string()).optional(),
        mandatory: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type Capability = z.infer<typeof capabilitySchema>;
export function resolveModel(input: string | number) {
  const model = MODEL_REGISTRY.find(
    (m) => String(m.number) === String(input) || m.id === input,
  );
  if (!model)
    throw new Error(
      "Select a registered model number (1–6) or its exact slug.",
    );
  return model;
}
export async function fetchCapabilities(): Promise<Capability[]> {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Model catalog HTTP ${response.status}`);
  const body = z
    .object({ data: z.array(capabilitySchema) })
    .parse(await response.json());
  return body.data.filter((m) => MODEL_REGISTRY.some((r) => r.id === m.id));
}
export function requireCapability(
  catalog: Capability[],
  id: string,
  effort: Effort,
) {
  const model = catalog.find((m) => m.id === id);
  if (!model)
    throw new Error(`Model unavailable in OpenRouter's current catalog: ${id}`);
  const missing = [
    "tools",
    "tool_choice",
    "reasoning",
    "structured_outputs",
  ].filter((p) => !model.supported_parameters.includes(p));
  if (missing.length)
    throw new Error(`${id} does not advertise ${missing.join(", ")}`);
  if (
    model.reasoning?.supported_efforts &&
    !model.reasoning.supported_efforts.includes(effort)
  ) {
    throw new Error(
      `${id} supports reasoning efforts: ${model.reasoning.supported_efforts.join(", ")}`,
    );
  }
  return model;
}
