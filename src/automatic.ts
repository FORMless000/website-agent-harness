import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Harness } from "./harness.js";
import { normalizePath, type ReferenceId, type Session } from "./contracts.js";
import { atomicWrite, now } from "./store.js";
import { redact } from "./agent.js";
import { requireCapability } from "./models.js";
import { sameRoot } from "./preparation.js";
import {
  Settings,
  executionConfig,
  type AutomaticSettings,
} from "./settings.js";

export interface AutomaticAttempt {
  destinationDescription?: string;
  id: string;
  path: string;
  status: "running" | "success" | "failed";
  startedAt: string;
  finishedAt?: string;
  referringUrl: string | null;
  internalReference: ReferenceId | null;
  referenceReason: string;
  settings: AutomaticSettings;
  populationId?: string;
  sessionId?: string;
  runId?: string;
  phase?: "preparing" | "description";
  warnings: string[];
  error?: string;
}
function distance(a: string, b: string) {
  const x = a.split("/").filter(Boolean),
    y = b.split("/").filter(Boolean);
  let common = 0;
  while (common < Math.min(x.length, y.length) && x[common] === y[common])
    common++;
  return x.length + y.length - 2 * common;
}
export function selectReference(
  sessions: Session[],
  target: string,
  referring: string | null,
  port: number,
) {
  if (referring) {
    try {
      const url = new URL(referring);
      if (
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname) &&
        url.port === String(port) &&
        !url.username &&
        !url.password
      ) {
        const archived = sessions.find(
          (s) => s.archived?.url === decodeURI(url.pathname),
        );
        if (archived?.archived)
          return {
            reference: {
              sessionId: archived.id,
              versionId: archived.archived.versionId,
            },
            reason: "referring archive",
          };
        const preview = /^\/api\/preview\/([\w-]+)\/([\w-]+)$/.exec(
          url.pathname,
        );
        if (
          preview &&
          sessions.some(
            (s) => s.id === preview[1] && s.versions.includes(preview[2]),
          )
        )
          return {
            reference: { sessionId: preview[1], versionId: preview[2] },
            reason: "referring preview",
          };
        const page = sessions.find(
          (s) =>
            !s.archived &&
            s.path === normalizePath(url.pathname) &&
            s.currentVersion,
        );
        if (page)
          return {
            reference: { sessionId: page.id, versionId: page.currentVersion! },
            reason: "referring page",
          };
      }
    } catch {
      /* Invalid/unresolvable referrers fall back to stored neighbors. */
    }
  }
  const published = sessions.filter(
    (s) => !s.archived && s.currentVersion && s.path !== target,
  );
  const local = published.filter((s) => sameRoot(s.path, target));
  const candidates = local.length ? local : published;
  candidates.sort(
    (a, b) =>
      distance(a.path, target) - distance(b.path, target) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  const nearest = candidates[0];
  return {
    reference: nearest
      ? { sessionId: nearest.id, versionId: nearest.currentVersion! }
      : null,
    reason: nearest
      ? local.length
        ? "nearest same-site page"
        : "nearest project page"
      : "no published reference",
  };
}

// Only coordinates existing population/create/run calls. Records here connect their traces.
export class AutomaticPages {
  readonly settings: Settings;
  private records = new Map<string, AutomaticAttempt>();
  private latest = new Map<string, AutomaticAttempt>();
  private pending = new Map<string, Promise<void>>();
  private ready?: Promise<void>;
  private closing = false;
  constructor(private harness: Harness) {
    this.settings = new Settings(harness.config);
  }
  private save(record: AutomaticAttempt) {
    return atomicWrite(
      this.harness.store.file("automatic", record.id),
      JSON.stringify(record, null, 2),
    );
  }
  initialize() {
    return (this.ready ??= (async () => {
      const ids = await readdir(
        path.join(this.harness.config.dataDir, "automatic"),
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      const records = await Promise.all(
        ids.map((id) =>
          this.harness.store.json<AutomaticAttempt>(
            this.harness.store.file("automatic", id),
          ),
        ),
      );
      for (const record of records.sort((a, b) =>
        a.startedAt.localeCompare(b.startedAt),
      )) {
        if (record.status === "running") {
          record.status = "failed";
          record.error = "Server stopped during this attempt.";
          record.finishedAt = now();
          await this.save(record);
        }
        this.records.set(record.id, record);
        this.latest.set(record.path, record);
      }
    })());
  }
  async list() {
    await this.initialize();
    return [...this.records.values()].reverse();
  }
  async get(id: string) {
    await this.initialize();
    const record = this.records.get(id);
    if (!record) throw new Error("Automatic attempt not found.");
    return record;
  }
  async progress(id: string) {
    const record = await this.get(id);
    const active = record.sessionId
      ? this.harness.active.get(record.sessionId)
      : undefined;
    return {
      id: record.id,
      status: record.status,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      phase: active?.phase ?? record.phase ?? "preparing",
    };
  }
  async wait(id: string) {
    await this.pending.get(id);
    return this.get(id);
  }
  async ensure(
    pagePath: string,
    referringUrl: string | null,
    retryId?: string,
    destinationDescription = "",
  ): Promise<AutomaticAttempt | null> {
    pagePath = normalizePath(pagePath);
    await this.initialize();
    if (this.closing) return null;
    const previous = this.latest.get(pagePath);
    if (
      previous?.status === "running" ||
      (retryId && previous?.status === "success")
    )
      return previous;
    if (previous?.status === "failed" && retryId !== previous.id)
      return previous;
    if (retryId && previous?.id !== retryId) return previous ?? null;
    const { settings } = await this.settings.get();
    // Recheck after I/O: only one visitor may claim the attempt.
    if (this.latest.get(pagePath) !== previous)
      return this.latest.get(pagePath)!;
    if (!settings.enabled) return null;
    // Store only a local reference identity, never query strings or arbitrary headers.
    try {
      const source = new URL(referringUrl ?? "");
      referringUrl =
        source.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(source.hostname) &&
        source.port === String(this.harness.config.port) &&
        !source.username &&
        !source.password
          ? source.origin + source.pathname
          : null;
    } catch {
      referringUrl = null;
    }
    const record: AutomaticAttempt = {
      id: randomUUID(),
      path: pagePath,
      status: "running",
      startedAt: now(),
      referringUrl:
        previous?.status === "failed" ? previous.referringUrl : referringUrl,
      internalReference: null,
      referenceReason: "pending",
      settings,
      destinationDescription:
        previous?.status === "failed"
          ? previous.destinationDescription
          : destinationDescription,
      warnings: [],
    };
    this.latest.set(pagePath, record);
    this.records.set(record.id, record);
    const done = this.execute(record, Boolean(retryId)).catch((error) => {
      process.stderr.write(
        `Automatic attempt persistence error: ${String(redact(String(error), this.harness.config.apiKey))}\n`,
      );
    });
    this.pending.set(record.id, done);
    void done.finally(() => this.pending.delete(record.id));
    return record;
  }
  private async execute(record: AutomaticAttempt, retry: boolean) {
    const h = this.harness;
    const config = executionConfig(h.config, record.settings);
    let token: symbol | undefined;
    try {
      await this.save(record);
      await h.waitForPath(record.path);
      if (this.closing) throw new Error("Server shutting down.");
      token = h.reservePath(record.path);
      const existing = await h.store.byPath(record.path);
      if (existing) {
        record.sessionId = existing.id;
        record.internalReference = existing.generationParent ?? null;
        record.referenceReason = "existing session";
        record.populationId = existing.populationId;
        // Sessions retain their original model and conversation on retry.
        record.settings.websiteModel = existing.model;
        record.settings.websiteEffort = existing.effort;
        if (existing.currentVersion) {
          record.status = "success";
          return;
        }
        const active = h.active.get(existing.id);
        if (this.closing) throw new Error("Server shutting down.");
        if (!active && !retry)
          throw new Error(
            "Existing unpublished session requires an explicit retry.",
          );
        record.runId =
          active?.runId ??
          (
            await h.start(
              existing.id,
              `Generate the page at ${record.path}.`,
              config,
            )
          ).id;
      } else {
        const selected = selectReference(
          await h.store.sessions(),
          record.path,
          record.referringUrl,
          config.port,
        );
        record.internalReference = selected.reference;
        record.referenceReason = selected.reason;
        await this.save(record);
        let populatedBrief = "",
          populationId: string | undefined;
        let externalReferences: {
          url: string;
          compression: AutomaticSettings["externalCompression"];
        }[] = [];
        if (record.settings.descriptionEnabled) {
          record.phase = "description";
          try {
            if (!config.apiKey) throw new Error("API key is not configured.");
            requireCapability(
              await h.capabilities(),
              record.settings.descriptionModel,
              record.settings.descriptionEffort,
            );
            if (this.closing) throw new Error("Server shutting down.");
            const started = await h.populations.start(
              {
                path: record.path,
                description: record.destinationDescription ?? "",
                internalReference: record.internalReference,
                allowReferenceSuggestions: false,
                searchEnabled: record.settings.searchEnabled,
                model: record.settings.descriptionModel,
                effort: record.settings.descriptionEffort,
              },
              config,
            );
            record.populationId = started.id;
            if (this.closing) h.populations.active.get(started.id)?.abort();
            await this.save(record);
            const result = await h.populations.wait(started.id);
            if (result.status !== "success" || !result.result)
              throw new Error(result.error ?? "Population failed.");
            populationId = started.id;
            populatedBrief = result.result.brief;
            record.warnings.push(...result.result.warnings);
            if (record.settings.searchEnabled)
              externalReferences = result.result.externalReferences.map(
                (ref) => ({
                  url: ref.url,
                  compression: record.settings.externalCompression,
                }),
              );
          } catch (error) {
            record.warnings.push(
              `Description stage failed; using blank brief: ${String(redact(String(error), config.apiKey))}`,
            );
          }
        }
        record.phase = "preparing";
        if (this.closing) throw new Error("Server shutting down.");
        const created = await h.create(
          {
            path: record.path,
            description: record.destinationDescription ?? "",
            populatedBrief,
            populationId,
            model: record.settings.websiteModel,
            effort: record.settings.websiteEffort,
            internalReference: record.internalReference,
            internalCompression: record.settings.internalCompression,
            externalReferences,
          },
          {
            config,
            reservation: token,
            onReferenceWarning: (warning) =>
              record.warnings.push(String(redact(warning, config.apiKey))),
          },
        );
        record.sessionId = created.session.id;
        record.runId = created.run.id;
        if (this.closing && h.active.has(created.session.id))
          h.cancel(created.run.id);
      }
      await this.save(record);
      const run = await h.wait(record.runId!);
      if (run.status !== "success") throw new Error(run.error ?? run.status);
      record.status = "success";
    } catch (error) {
      record.status = "failed";
      record.error = String(redact(String(error), config.apiKey));
    } finally {
      if (token) h.releasePath(record.path, token);
      record.finishedAt = now();
      await this.save(record);
    }
  }
  async close() {
    this.closing = true;
    for (const controller of this.harness.populations.active.values())
      controller.abort();
    for (const active of this.harness.active.values())
      active.controller.abort(new Error("Server shutting down."));
    await Promise.allSettled(this.pending.values());
  }
}
