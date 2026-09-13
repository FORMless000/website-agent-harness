import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Harness } from "./harness.js";
import type { Region, Version } from "./contracts.js";
import { normalizePath } from "./contracts.js";
import { atomicWrite, now } from "./store.js";
import {
  Settings,
  executionConfig,
  type AutomaticSettings,
} from "./settings.js";
import { requireCapability } from "./models.js";
import { redact } from "./agent.js";
import { regionActions, validateRegionContent } from "./validation.js";
import {
  createInteractionDriver,
  transitionSchema,
  type InteractionDriver,
  type RegionTransition,
} from "./interaction-agent.js";

const identifier = z.string().regex(/^[\w-]+$/);
export const interactionRequestSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    event: z
      .object({
        action: z.string().min(1).max(200),
        inputs: z.record(
          z.string(),
          z.union([z.string(), z.array(z.string())]),
        ),
        state: z.record(z.string(), z.json()),
      })
      .strict(),
  })
  .strict();
type InteractionEvent = z.infer<typeof interactionRequestSchema>["event"];
interface Revision extends RegionTransition {
  revision: number;
  event?: InteractionEvent;
  at: string;
}
interface Visit {
  id: string;
  sessionId: string;
  versionId: string;
  pagePath: string;
  settings: AutomaticSettings;
}
interface RegionHistory {
  definition: Region;
  revisions: Revision[];
}
export class StaleInteraction extends Error {}

// A new visit is created for every document response. Artifacts remain immutable;
// independent region files avoid lost updates when sibling regions run in parallel.
export class Interactions {
  private busy = new Set<string>();
  constructor(
    private harness: Harness,
    private driver: InteractionDriver = createInteractionDriver(),
  ) {}
  private file(visitId: string, regionId?: string) {
    identifier.parse(visitId);
    if (regionId) identifier.parse(regionId);
    return this.harness.store.file(
      "visits",
      visitId,
      regionId ? `region-${regionId}.json` : "visit.json",
    );
  }
  async create(sessionId: string, pagePath: string, version: Version) {
    const visit: Visit = {
      id: randomUUID(),
      sessionId,
      versionId: version.id,
      pagePath,
      settings: (await new Settings(this.harness.config).get()).settings,
    };
    await atomicWrite(this.file(visit.id), JSON.stringify(visit));
    await Promise.all(
      (version.artifact.regions ?? []).map(async (definition) => {
        const history: RegionHistory = {
          definition,
          revisions: [
            {
              revision: 0,
              html: definition.html,
              css: definition.css,
              state: definition.state,
              destinations: [],
              at: now(),
            },
          ],
        };
        await atomicWrite(
          this.file(visit.id, definition.id),
          JSON.stringify(history),
        );
      }),
    );
    return { visitId: visit.id, regions: version.artifact.regions ?? [] };
  }
  async get(visitId: string, regionId: string) {
    const visit = await this.harness.store.json<Visit>(this.file(visitId));
    const history = await this.harness.store.json<RegionHistory>(
      this.file(visitId, regionId),
    );
    return { visit, history, current: history.revisions.at(-1)! };
  }
  async transition(visitId: string, regionId: string, value: unknown) {
    const input = interactionRequestSchema.parse(value);
    const key = this.file(visitId, regionId);
    if (this.busy.has(key))
      throw new StaleInteraction(
        "Region is already updating. Retry after it finishes.",
      );
    this.busy.add(key);
    try {
      const { visit, history, current } = await this.get(visitId, regionId);
      if (current.revision !== input.revision)
        throw new StaleInteraction("Stale region revision.");
      if (
        !history.definition.javascript &&
        !regionActions(current.html).has(input.event.action)
      )
        throw new Error("Action is not declared by the current region.");
      const config = executionConfig(this.harness.config, visit.settings);
      if (!config.apiKey) throw new Error("API key is not configured.");
      requireCapability(
        await this.harness.capabilities(),
        visit.settings.interactionModel,
        visit.settings.interactionEffort,
      );
      const version = await this.harness.store.version(
        visit.sessionId,
        visit.versionId,
      );
      const instructions = (await this.harness.prompts.list()).find(
        (p) => p.name === "interaction.md",
      )!.content;
      const trace: unknown[] = [];
      const traceFile = this.harness.store.file(
        "visits",
        visitId,
        `${regionId}-${randomUUID()}.trace.json`,
      );
      const validate = (value: unknown) => {
        const next = transitionSchema.parse(value);
        const errors = validateRegionContent(next, version.assets);
        if (errors.length) throw new Error(errors.join("; "));
        return next;
      };
      try {
        const next = validate(
          await this.driver({
            config,
            model: visit.settings.interactionModel,
            effort: visit.settings.interactionEffort,
            instructions,
            context: {
              purpose: history.definition.purpose,
              javascript: history.definition.javascript,
              history: history.revisions,
              event: input.event,
            },
            signal: AbortSignal.timeout(config.timeoutMs),
            emit: async (type, data) => {
              trace.push({
                at: now(),
                type,
                data: redact(data, config.apiKey),
              });
            },
            validate,
          }),
        );
        const revision: Revision = {
          ...next,
          revision: current.revision + 1,
          event: input.event,
          at: now(),
        };
        await atomicWrite(traceFile, JSON.stringify(trace));
        await atomicWrite(
          key,
          JSON.stringify({
            ...history,
            revisions: [...history.revisions, revision],
          }),
        );
        return revision;
      } catch (error) {
        trace.push({ at: now(), error: redact(String(error), config.apiKey) });
        await atomicWrite(traceFile, JSON.stringify(trace));
        throw error;
      }
    } finally {
      this.busy.delete(key);
    }
  }
  async navigation(visitId: string, regionId: string, value: unknown) {
    const { path } = z
      .object({ path: z.string().transform(normalizePath) })
      .strict()
      .parse(value);
    const { visit, current } = await this.get(visitId, regionId);
    // Only destinations already presented by this region may create a page.
    const { parseFragment } = await import("parse5");
    const { walk } = await import("./network.js");
    let linked = false;
    walk(parseFragment(current.html), (node) => {
      if (!("tagName" in node) || node.tagName !== "a") return;
      const href = node.attrs.find((a) => a.name === "href")?.value;
      if (href === path) linked = true;
    });
    const destination = current.destinations.find((d) => d.path === path);
    if (!linked && !destination)
      throw new Error("Destination is not declared by this region.");
    return { visit, path, description: destination?.description ?? "" };
  }
}
