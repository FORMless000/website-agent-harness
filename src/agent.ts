import { readFile } from "node:fs/promises";
import {
  callModel,
  tool,
  updateState,
  serializeConversationState,
  deserializeConversationState,
  type ConversationState,
  type FunctionCallOutputItem,
  type OutputFunctionCallItem,
} from "@openrouter/agent";
import { OpenRouter } from "@openrouter/sdk";
import { HTTPClient, type Fetcher } from "@openrouter/sdk/lib/http";
import {
  artifactSchema,
  describedArtifactSchema,
  styledArtifactSchema,
  type Artifact,
  type Asset,
  type StyleRecord,
  type ReferenceId,
} from "./contracts.js";
import { resolveStyle, SUBMIT_DESCRIPTION } from "./styles.js";
import { estimateRequest } from "./preparation.js";
import { ESTIMATOR } from "./compression.js";
import type { Config } from "./config.js";
import type { Effort } from "./models.js";
import { AssetTools, type Emit } from "./assets.js";
import { atomicWrite, hash } from "./store.js";
import type { ContextMessage } from "./context.js";
import { validateArtifact } from "./validation.js";
import { recordResponse } from "./trace.js";

export interface AgentInput {
  described?: boolean;
  styled?: boolean;
  base?: { id: ReferenceId; css: string };
  originalInput?: unknown;
  config: Config;
  model: string;
  effort: Effort;
  instructions: string;
  input: string | ContextMessage[];
  cachePrefix?: string;
  stateFile: string;
  signal: AbortSignal;
  emit: Emit;
  assets: Asset[];
}
export interface AgentOutput {
  pageDescription?: string;
  style?: StyleRecord;
  artifact: Artifact;
  staged: AssetTools["staged"];
  text: string;
}
export type Driver = (input: AgentInput) => Promise<AgentOutput>;

// Never log authorization headers. Defensive redaction also catches a key
// accidentally pasted into a description or returned in a provider error.
export function redact(value: unknown, key = ""): unknown {
  if (typeof value === "string")
    return (key ? value.split(key).join("[REDACTED]") : value).replace(
      /sk-or-v1-[a-zA-Z0-9_-]+/g,
      "[REDACTED]",
    );
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /^(authorization|api_?key|access_?token)$/i.test(k)
          ? "[REDACTED]"
          : redact(v, key),
      ]),
    );
  return value;
}
export function createDriver(fetcher?: Fetcher): Driver {
  return async (context) => {
    const { config, emit, signal } = context;
    const assetTools = new AssetTools(config, emit, signal);
    let accepted: Artifact | undefined;
    let acceptedStyle: StyleRecord | undefined;
    let pageDescription: string | undefined;
    const submit = tool({
      name: "submit_website",
      description: SUBMIT_DESCRIPTION,
      strict: true,
      inputSchema: context.described
        ? describedArtifactSchema
        : context.styled
          ? styledArtifactSchema
          : artifactSchema,
      execute: false,
    });
    const httpClient = new HTTPClient({ fetcher });
    const captures: Promise<{ error?: unknown }>[] = [];
    let requestIndex = 0;
    httpClient.addHook("beforeRequest", async (request) => {
      const body = await request.clone().text();
      const payload = JSON.parse(body);
      if (context.styled)
        await emit("context.estimate", {
          estimator: ESTIMATOR,
          request: ++requestIndex,
          final: estimateRequest(
            payload.instructions ?? "",
            payload.input,
            payload.tools,
          ),
          before:
            requestIndex === 1 && context.originalInput
              ? estimateRequest(
                  payload.instructions ?? "",
                  context.originalInput,
                  payload.tools,
                )
              : null,
        });
      if (context.cachePrefix !== undefined) {
        // Hash actual serialized tool schemas, not SDK tool objects/functions.
        const affinity = hash(
          JSON.stringify({
            model: context.model,
            instructions: context.instructions,
            tools: payload.tools,
            reference: context.cachePrefix,
          }),
        );
        request.headers.set("x-session-id", `vibenet-${affinity}`);
        await emit("cache.policy", {
          affinityKey: affinity,
          boundary: context.cachePrefix
            ? "eligible for reuse"
            : "system prefix only; automatic caching",
        });
      }
      await emit("request", {
        url: request.url,
        method: request.method,
        body: payload,
      });
    });
    httpClient.addHook("response", (response) => {
      captures.push(
        recordResponse(response.clone(), emit).then(
          () => ({}),
          (error) => ({ error }),
        ),
      );
    });
    const client = new OpenRouter({
      apiKey: config.apiKey,
      httpClient,
      retryConfig: { strategy: "none" },
      debugLogger: { group() {}, groupEnd() {}, log() {} },
    });
    // Serialize with SDK helpers; never rewrite reasoning items. This harness
    // owns the manual-tool boundary because SDK 0.11.0's automatic stopWhen
    // checks run AFTER a follow-up request (even after successful submission).
    const state = {
      load: async (): Promise<ConversationState | null> => {
        try {
          return deserializeConversationState(
            await readFile(context.stateFile, "utf8"),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
      save: async (value: ConversationState) =>
        atomicWrite(context.stateFile, serializeConversationState(value)),
    };
    async function settle(outputs: FunctionCallOutputItem[]) {
      const current = await state.load();
      if (!current) throw new Error("SDK state was not persisted.");
      const history = Array.isArray(current.messages)
        ? current.messages
        : [
            {
              type: "message" as const,
              role: "user" as const,
              content: current.messages,
            },
          ];
      await state.save(
        updateState(current, {
          messages: [...history, ...outputs],
          pendingToolCalls: [],
          status: "complete",
        }),
      );
    }
    const prior = await state.load();
    if (prior?.pendingToolCalls?.length) {
      await settle(
        prior.pendingToolCalls.map((call) => ({
          type: "function_call_output",
          callId: call.id,
          output: JSON.stringify({
            error:
              "Previous run interrupted before this tool result was saved. No result is assumed.",
          }),
        })),
      );
      await emit("state.recovered", {
        pendingCalls: prior.pendingToolCalls.length,
      });
    }
    const definitions = [submit, ...assetTools.tools()];
    const texts: string[] = [];
    for (let step = 1; step <= config.maxSteps; step++) {
      signal.throwIfAborted();
      await emit("step.start", { step });
      const result = callModel(client, {
        model: context.model,
        instructions: context.instructions,
        input: step === 1 ? context.input : [],
        reasoning: { effort: context.effort },
        ...(context.cachePrefix === "" && context.model.startsWith("anthropic/")
          ? { cacheControl: { type: "ephemeral" as const } }
          : {}),
        provider: { requireParameters: true },
        tools: definitions,
        state,
        signal,
        allowFinalResponse: false,
        truncation: "disabled",
        store: false,
      });
      const captureStart = captures.length;
      const [completed] = await Promise.allSettled([result.getResponse()]);
      const recorded = await Promise.all(captures.slice(captureStart));
      for (const capture of recorded)
        if ("error" in capture) throw capture.error;
      if (completed.status === "rejected") throw completed.reason;
      const response = completed.value;
      await emit("response", response);
      await emit("step.end", {
        step,
        usage: response.usage,
        status: response.status,
      });
      texts.push(await result.getText());
      const calls = response.output.filter(
        (item): item is OutputFunctionCallItem =>
          item.type === "function_call" && "callId" in item,
      );
      if (!calls.length) break;
      const outputs: FunctionCallOutputItem[] = [];
      for (const call of calls) {
        let output: unknown;
        try {
          signal.throwIfAborted();
          if (accepted)
            throw new Error("Skipped: a website has already been accepted.");
          const input: unknown = JSON.parse(call.arguments);
          await emit("tool.call", {
            name: call.name,
            callId: call.callId,
            input,
          });
          if (call.name === "submit_website") {
            let resolved: ReturnType<typeof resolveStyle> | undefined;
            try {
              if (context.described) {
                const described = describedArtifactSchema.parse(input);
                const { pageDescription: description, ...artifact } = described;
                resolved = resolveStyle(
                  { ...artifact, schemaVersion: 2 },
                  context.base,
                );
                pageDescription = description;
              } else if (context.styled)
                resolved = resolveStyle(input, context.base);
            } catch (error) {
              await emit("style.decision", {
                submission: input,
                accepted: false,
                errors: [String(error)],
              });
              throw error;
            }
            const validation = validateArtifact(resolved?.artifact ?? input, [
              ...context.assets,
              ...assetTools.staged.map((a) => a.meta),
            ]);
            accepted = validation.artifact;
            if (resolved) {
              acceptedStyle = accepted ? resolved.style : undefined;
              await emit("style.decision", {
                ...resolved.style,
                accepted: !!accepted,
                errors: validation.errors,
                authoredChars: resolved.style.authoredCss?.length ?? 0,
                resolvedChars: resolved.style.resolvedCss?.length ?? 0,
              });
            }
            output = { accepted: !!accepted, errors: validation.errors };
            await emit("validation", {
              ...(output as object),
              artifact: input,
            });
          } else output = await assetTools.execute(call.name, input);
        } catch (error) {
          output = { error: String(error) };
        }
        await emit("tool.result", {
          name: call.name,
          callId: call.callId,
          output,
        });
        outputs.push({
          type: "function_call_output",
          callId: call.callId,
          output: JSON.stringify(output),
        });
      }
      // Pair every call, including failures/skips, before stopping or cancelling.
      await settle(outputs);
      signal.throwIfAborted();
      if (accepted)
        return {
          artifact: accepted,
          pageDescription,
          style: acceptedStyle,
          staged: assetTools.staged,
          text: texts.filter(Boolean).join("\n"),
        };
    }
    throw new Error(
      "The run ended without an accepted website. See the trace for provider errors, validation feedback, or the step limit.",
    );
  };
}
