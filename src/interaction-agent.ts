import {
  callModel,
  tool,
  updateState,
  type ConversationState,
  type FunctionCallOutputItem,
  type OutputFunctionCallItem,
} from "@openrouter/agent";
import { OpenRouter } from "@openrouter/sdk";
import { HTTPClient, type Fetcher } from "@openrouter/sdk/lib/http";
import { z } from "zod";
import { type Config } from "./config.js";
import { normalizePath } from "./contracts.js";
import { type Effort } from "./models.js";
import type { Emit } from "./assets.js";
import { redact } from "./agent.js";
import { recordResponse } from "./trace.js";

export const transitionSchema = z
  .object({
    html: z.string().describe("HTML fragment rendered inside the region."),
    css: z.string().nullable(),
    state: z.record(z.string(), z.json()),
    destinations: z.array(
      z
        .object({
          path: z.string().refine((value) => {
            try {
              return normalizePath(value) === value;
            } catch {
              return false;
            }
          }, "Use a normalized absolute local sub-URL path."),
          description: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type RegionTransition = z.infer<typeof transitionSchema>;

export interface InteractionInput {
  config: Config;
  model: string;
  effort: Effort;
  instructions: string;
  context: unknown;
  signal: AbortSignal;
  emit: Emit;
  validate: (value: unknown) => RegionTransition;
}
export type InteractionDriver = (
  input: InteractionInput,
) => Promise<RegionTransition>;

export function createInteractionDriver(fetcher?: Fetcher): InteractionDriver {
  return async (input) => {
    const { config, emit, signal } = input;
    const client = new HTTPClient({ fetcher });
    const captures: Promise<void>[] = [];
    const captureErrors: unknown[] = [];
    let providerError: string | undefined;
    let requestCount = 0;
    client.addHook("beforeRequest", async (request) => {
      if (++requestCount > config.maxSteps)
        throw new Error("Interaction step limit reached.");
      const body = JSON.parse(await request.clone().text());
      await emit("request", {
        url: request.url,
        method: request.method,
        body,
      });
      return request;
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
          await emit(type, data);
        }).catch((error) => {
          captureErrors.push(error);
        }),
      );
    });
    const submit = tool({
      name: "submit_region",
      description:
        "Submit the complete updated region fragment, stylesheet, state, and local navigation destinations.",
      inputSchema: transitionSchema,
      strict: true,
      execute: false,
    });
    const state = {
      conversation: null as ConversationState | null,
      load: async () => state.conversation,
      save: async (value: ConversationState) => {
        state.conversation = value;
      },
    };
    let accepted: RegionTransition | undefined;
    try {
      for (let step = 1; step <= config.maxSteps; step++) {
        signal.throwIfAborted();
        await emit("step.start", { step });
        const result = callModel(
          new OpenRouter({
            apiKey: config.apiKey,
            httpClient: client,
            retryConfig: { strategy: "none" },
            debugLogger: { group() {}, groupEnd() {}, log() {} },
          }),
          {
            model: input.model,
            reasoning: { effort: input.effort },
            instructions: input.instructions,
            input: step === 1 ? JSON.stringify(input.context) : [],
            tools: [submit],
            state,
            allowFinalResponse: false,
            store: false,
            truncation: "disabled",
            signal,
          },
        );
        const captureStart = captures.length;
        const [completed] = await Promise.allSettled([result.getResponse()]);
        await Promise.all(captures.slice(captureStart));
        if (captureErrors.length) throw captureErrors[0];
        if (completed.status === "rejected") throw completed.reason;
        const response = completed.value;
        await emit("response", response);
        await emit("usage", response.usage ?? null);
        const calls = response.output.filter(
          (item): item is OutputFunctionCallItem =>
            item.type === "function_call" && "callId" in item,
        );
        const outputs: FunctionCallOutputItem[] = [];
        for (const call of calls) {
          let feedback: {
            accepted: boolean;
            result?: RegionTransition;
            error?: string;
          };
          try {
            if (accepted || call.name !== "submit_region")
              throw new Error("Unexpected or duplicate submission.");
            const value = input.validate(JSON.parse(call.arguments));
            accepted = value;
            feedback = { accepted: true, result: value };
          } catch (error) {
            feedback = { accepted: false, error: String(error) };
          }
          await emit("interaction.decision", feedback);
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
      throw new Error("Interaction ended without an accepted result.");
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
