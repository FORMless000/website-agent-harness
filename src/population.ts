import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  callModel,
  tool,
  serverTool,
  updateState,
  type ConversationState,
  type FunctionCallOutputItem,
} from "@openrouter/agent";
import { OpenRouter } from "@openrouter/sdk";
import { HTTPClient, type Fetcher } from "@openrouter/sdk/lib/http";
import {
  normalizePath,
  referenceIdSchema,
  type RunEvent,
} from "./contracts.js";
import { effortSchema, resolveModel } from "./models.js";
import { publicConfig, type Config } from "./config.js";
import { Store, atomicWrite, now } from "./store.js";
import { Prompts } from "./prompts.js";
import { sameRoot } from "./preparation.js";
import { indexDescriptions } from "./descriptions.js";
import { redact } from "./agent.js";
import { recordResponse } from "./trace.js";
import type { Emit } from "./assets.js";

export const populationRequestSchema = z
  .object({
    path: z.string().transform(normalizePath),
    description: z.string().default(""),
    internalReference: referenceIdSchema.nullable().default(null),
    allowReferenceSuggestions: z.boolean().default(false),
    searchEnabled: z.boolean().default(true),
    model: z.union([z.string(), z.number()]),
    effort: effortSchema.default("high"),
  })
  .strict();
const externalUrl = z
  .string()
  .describe(
    "An absolute public HTTP(S) URL without credentials; validated by the host.",
  )
  .refine((v) => {
    try {
      const u = new URL(v);
      return (
        ["http:", "https:"].includes(u.protocol) && !u.username && !u.password
      );
    } catch {
      return false;
    }
  }, "Use public HTTP(S) URLs without credentials.");
export const populationResultSchema = z
  .object({
    brief: z.string().trim().min(1),
    similarity: z.enum(["similar", "divergent", "insufficient_evidence"]),
    rationale: z.string().min(1),
    relevantNeighbors: z.array(referenceIdSchema),
    externalReferences: z
      .array(
        z
          .object({
            url: externalUrl,
            reason: z.string().min(1),
            provenance: z.string().min(1),
          })
          .strict(),
      )
      .max(3),
    referenceRecommendation: z
      .object({
        action: z.enum(["retain", "clear", "replace"]),
        reference: referenceIdSchema.nullable(),
        rationale: z.string(),
      })
      .strict(),
    warnings: z.array(z.string()),
  })
  .strict();
export type PopulationResult = z.infer<typeof populationResultSchema>;
export type PopulationInput = z.infer<typeof populationRequestSchema>;
export interface PopulationContext {
  query: { path: string; manualInstructions: string };
  referringUrl: string | null;
  allowReferenceSuggestions: boolean;
  searchEnabled?: boolean;
  neighbors: {
    sessionId: string;
    versionId: string;
    url: string;
    pageDescription: string;
  }[];
  worldKnowledge: string[];
}
export interface PopulationRecord {
  id: string;
  status: "running" | "success" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  input: PopulationInput;
  context: PopulationContext;
  instructions: string;
  config?: ReturnType<typeof publicConfig>;
  result?: PopulationResult;
  error?: string;
}
export function validatePopulation(value: unknown, context: PopulationContext) {
  const result = populationResultSchema.parse(value);
  const exists = (r: { sessionId: string; versionId: string }) =>
    context.neighbors.some(
      (n) => n.sessionId === r.sessionId && n.versionId === r.versionId,
    );
  if (result.relevantNeighbors.some((r) => !exists(r)))
    throw new Error("Unknown neighbor ID.");
  const recommendation = result.referenceRecommendation;
  if (!context.allowReferenceSuggestions && recommendation.action !== "retain")
    throw new Error(
      "Reference suggestions are disabled; retain the selected reference.",
    );
  if (
    recommendation.action === "replace" &&
    (!recommendation.reference || !exists(recommendation.reference))
  )
    throw new Error("Replacement must name a supplied neighbor.");
  if (recommendation.action !== "replace" && recommendation.reference !== null)
    throw new Error("Only replacement specifies reference IDs.");
  return result;
}
export type PopulationDriver = (
  config: Config,
  record: PopulationRecord,
  signal: AbortSignal,
  emit: Emit,
) => Promise<PopulationResult>;
export function createPopulationDriver(fetcher?: Fetcher): PopulationDriver {
  return async (config, record, signal, emit) => {
    let accepted: PopulationResult | undefined;
    let requestCount = 0;
    const client = new HTTPClient({ fetcher });
    const captures: Promise<void>[] = [];
    const searchUrls = new Set<string>();
    const captureErrors: unknown[] = [];
    let providerError: string | undefined;
    function searchEvidence(value: unknown) {
      if (!value || typeof value !== "object") return;
      const item = value as Record<string, unknown>;
      if (
        item.type === "openrouter:web_search" &&
        item.status === "completed"
      ) {
        const action = item.action as
          | { sources?: { url?: string }[] }
          | undefined;
        for (const source of action?.sources ?? [])
          if (source.url) searchUrls.add(source.url);
      }
      for (const child of Object.values(item)) {
        if (Array.isArray(child)) child.forEach(searchEvidence);
        else if (child && typeof child === "object") searchEvidence(child);
      }
    }
    client.addHook("beforeRequest", async (request) => {
      if (++requestCount > config.maxSteps)
        throw new Error("Population step limit reached.");
      const body = JSON.parse(await request.clone().text());
      // Installed SDK omits this documented server-tool field. Add it at the
      // captured transport boundary so the configured search-call limit is real.
      for (const t of body.tools ?? [])
        if (t.type === "openrouter:web_search")
          t.parameters.max_uses = config.populationSearches;
      if (requestCount > 1)
        body.tools = body.tools.filter(
          (t: { type: string }) => t.type !== "openrouter:web_search",
        );
      await emit("request", { url: request.url, body });
      return new Request(request, { body: JSON.stringify(body) });
    });
    client.addHook("response", (response) => {
      captures.push(
        recordResponse(response.clone(), async (type, data) => {
          if (type === "provider.http") {
            const http = data as {
              status: number;
              body?: {
                error?: { message?: string; metadata?: { raw?: string } };
              };
            };
            if (http.status >= 400) {
              let detail =
                http.body?.error?.metadata?.raw ??
                http.body?.error?.message ??
                "Provider request failed";
              try {
                detail = JSON.parse(detail).error?.message ?? detail;
              } catch {}
              providerError = `HTTP ${http.status}: ${detail}`;
            }
          }
          if (type === "provider.event") searchEvidence(data);
          await emit(type, data);
        }).catch((error) => {
          captureErrors.push(error);
        }),
      );
    });
    const submit = tool({
      name: "submit_population",
      description:
        "Submit the complete brief and recommendations. Correct validation errors if rejected.",
      inputSchema: populationResultSchema,
      strict: true,
      execute: false,
    });
    const search = {
      type: "openrouter:web_search" as const,
      parameters: {
        engine: "exa" as const,
        maxResults: config.populationSearchResults,
        maxTotalResults:
          config.populationSearches * config.populationSearchResults,
      },
    };
    try {
      let conversation: ConversationState | null = null;
      const state = {
        load: async () => conversation,
        save: async (value: ConversationState) => {
          conversation = value;
        },
      };
      for (let step = 1; step <= config.maxSteps; step++) {
        const result = callModel(
          new OpenRouter({ apiKey: config.apiKey, httpClient: client }),
          {
            model: resolveModel(record.input.model).id,
            reasoning: { effort: record.input.effort },
            instructions: record.instructions,
            input: step === 1 ? JSON.stringify(record.context) : [],
            tools:
              step === 1 && record.input.searchEnabled !== false
                ? [submit, serverTool(search)]
                : [submit],
            state,
            // Search is offered only on the first request, bounding total search uses across repairs.
            allowFinalResponse: false,
            store: false,
            truncation: "disabled",
            signal,
          },
        );
        const response = await result.getResponse();
        await Promise.all(captures);
        if (captureErrors.length) throw captureErrors[0];
        await emit("response", response);
        await emit("usage", response.usage ?? null);
        const outputs: FunctionCallOutputItem[] = [];
        for (const call of response.output) {
          if (call.type !== "function_call" || !("callId" in call)) continue;
          let feedback: unknown;
          try {
            if (accepted || call.name !== "submit_population")
              throw new Error("Unexpected or duplicate submission.");
            const value = validatePopulation(
              JSON.parse(call.arguments),
              record.context,
            );
            if (
              value.externalReferences.some((ref) => !searchUrls.has(ref.url))
            )
              throw new Error(
                "External reference URL lacks recorded successful search-source evidence. Use recorded source URLs, or return no external references with a warning if the provider did not expose sources.",
              );
            accepted = value;
            feedback = { accepted: true, result: value };
          } catch (error) {
            feedback = { accepted: false, error: String(error) };
          }
          await emit("population.decision", feedback);
          outputs.push({
            type: "function_call_output",
            callId: call.callId,
            output: JSON.stringify(feedback),
          });
        }
        const current = await state.load();
        if (current)
          await state.save(
            updateState(current, {
              messages: [
                ...(Array.isArray(current.messages)
                  ? current.messages
                  : [
                      {
                        type: "message" as const,
                        role: "user" as const,
                        content: current.messages,
                      },
                    ]),
                ...outputs,
              ],
              pendingToolCalls: [],
              status: "complete",
            }),
          );
        signal.throwIfAborted();
        if (accepted) return accepted;
      }
      throw new Error("Population ended without an accepted result.");
    } catch (error) {
      await Promise.all(captures);
      throw new Error(
        String(redact(providerError ?? String(error), config.apiKey)),
        { cause: error },
      );
    } finally {
      await Promise.all(captures);
      if (captureErrors.length) throw captureErrors[0];
    }
  };
}
export class Populations {
  active = new Map<string, AbortController>();
  private pending = new Map<string, Promise<void>>();
  async wait(id: string) {
    await this.pending.get(id);
    return this.get(id);
  }
  constructor(
    private config: Config,
    private store: Store,
    private prompts: Prompts,
    private driver = createPopulationDriver(),
  ) {}
  async get(id: string) {
    const record = await this.store.json<PopulationRecord>(
      this.store.file("populations", id),
    );
    if (record.status === "running" && !this.active.has(id)) {
      record.status = "failed";
      record.error = "Population interrupted by server restart.";
      record.finishedAt = now();
      await atomicWrite(
        this.store.file("populations", id),
        JSON.stringify(record),
      );
    }
    return record;
  }
  async events(id: string): Promise<RunEvent[]> {
    const text = await readFile(
      this.store.file("populations", id, "events.jsonl"),
      "utf8",
    );
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  }
  async start(value: unknown, override?: Config) {
    const config = { ...(override ?? this.config) };
    const input = populationRequestSchema.parse(value);
    input.model = resolveModel(input.model).id;
    const descriptions = await indexDescriptions(this.store);
    const sessions = await this.store.sessions();
    const candidates = sessions
      .filter(
        (s) => !s.archived && s.currentVersion && sameRoot(s.path, input.path),
      )
      .map((s) => ({ sessionId: s.id, versionId: s.currentVersion! }));
    if (input.internalReference) candidates.unshift(input.internalReference);
    const neighbors: PopulationContext["neighbors"] = [];
    for (const ref of candidates) {
      if (
        neighbors.some(
          (n) => n.sessionId === ref.sessionId && n.versionId === ref.versionId,
        )
      )
        continue;
      const session = sessions.find((s) => s.id === ref.sessionId);
      if (!session?.versions.includes(ref.versionId))
        throw new Error("Referring version is missing.");
      neighbors.push({
        ...ref,
        url: session.path,
        pageDescription:
          descriptions.find(
            (d) =>
              d.sessionId === ref.sessionId && d.versionId === ref.versionId,
          )?.pageDescription ?? "",
      });
    }
    neighbors.sort(
      (a, b) =>
        a.url.localeCompare(b.url) || a.versionId.localeCompare(b.versionId),
    );
    let worldKnowledge: string[] = [];
    try {
      worldKnowledge = z
        .array(z.string())
        .parse(
          JSON.parse(
            await readFile(
              path.join(config.root, "world-knowledge.json"),
              "utf8",
            ),
          ),
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const record: PopulationRecord = {
      id: randomUUID(),
      status: "running",
      startedAt: now(),
      input,
      config: publicConfig(config),
      context: {
        query: { path: input.path, manualInstructions: input.description },
        referringUrl: input.internalReference
          ? sessions.find((s) => s.id === input.internalReference!.sessionId)!
              .path
          : null,
        allowReferenceSuggestions: input.allowReferenceSuggestions,
        searchEnabled: input.searchEnabled,
        neighbors,
        worldKnowledge,
      },
      instructions: (await this.prompts.list()).find(
        (p) => p.name === "population.md",
      )!.content,
    };
    const controller = new AbortController();
    this.active.set(record.id, controller);
    await atomicWrite(
      this.store.file("populations", record.id),
      JSON.stringify(record),
    );
    await atomicWrite(
      this.store.file("populations", record.id, "events.jsonl"),
      "",
    );
    let seq = 0;
    let pending = Promise.resolve();
    const emit: Emit = async (type, data) => {
      const event = {
        seq: ++seq,
        at: now(),
        type,
        data: redact(data, config.apiKey),
      };
      pending = pending.then(async () => {
        const { appendFile } = await import("node:fs/promises");
        await appendFile(
          this.store.file("populations", record.id, "events.jsonl"),
          JSON.stringify(event) + "\n",
        );
      });
      await pending;
    };
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const done = (async () => {
      try {
        await emit("population.start", record);
        record.result = await this.driver(
          config,
          record,
          controller.signal,
          emit,
        );
        controller.signal.throwIfAborted();
        record.status = "success";
      } catch (error) {
        record.status = controller.signal.aborted ? "cancelled" : "failed";
        record.error = String(redact(String(error), config.apiKey));
      } finally {
        clearTimeout(timer);
        record.finishedAt = now();
        await atomicWrite(
          this.store.file("populations", record.id),
          JSON.stringify(record),
        );
        await emit("population.end", record);
        this.active.delete(record.id);
      }
    })().catch((error) => {
      this.active.delete(record.id);
      process.stderr.write(
        `Population persistence failure: ${String(redact(String(error), config.apiKey))}\n`,
      );
    });
    this.pending.set(record.id, done);
    void done.finally(() => this.pending.delete(record.id));
    return { id: record.id, status: "running" };
  }
}
