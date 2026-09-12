import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type Config } from "./config.js";
import { Store, hash, atomicWrite } from "./store.js";
import {
  createSchema,
  type ReferenceId,
  type ParentSnapshot,
  type Asset,
  type Compression,
} from "./contracts.js";
import { captureParent } from "./network.js";
import {
  variant,
  LEVELS,
  tokens,
  ESTIMATOR,
  type Variant,
} from "./compression.js";
import { initialContext, type ContextMessage } from "./context.js";

export type CreateRequest = z.infer<typeof createSchema>;
export interface PreparedReference {
  source: ParentSnapshot;
  original: string;
  variants: Record<Compression, Variant>;
  id?: ReferenceId;
}
export interface Preparation {
  id: string;
  transformationVersion: 2;
  estimator?: string;
  fingerprint: string;
  createdAt: string;
  internal?: PreparedReference;
  external: PreparedReference[];
  base?: { id: ReferenceId; path: string; css: string; assets: Asset[] };
}
export const sameRoot = (a: string, b: string) =>
  a.split("/")[1] === b.split("/")[1];
export const sourceFingerprint = (request: CreateRequest) =>
  hash(
    JSON.stringify({
      path: request.path,
      internalReference: request.internalReference ?? null,
      external: request.externalReferences?.map((r) => r.url) ?? [],
    }),
  );
export async function internalSnapshot(
  store: Store,
  id: ReferenceId,
  port: number,
) {
  const session = await store.session(id.sessionId);
  if (!session.versions.includes(id.versionId))
    throw new Error("Reference version does not belong to session.");
  const version = await store.version(id.sessionId, id.versionId);
  const url = `http://127.0.0.1:${port}${session.path}`;
  const source: ParentSnapshot = {
    url,
    finalUrl: url,
    capturedAt: version.createdAt,
    html: version.artifact.html,
    sha256: hash(version.artifact.html),
    localVersion: version.id,
    stylesheets: version.artifact.css
      ? [{ url, css: version.artifact.css, sha256: hash(version.artifact.css) }]
      : [],
    warnings: [],
    assets: version.assets,
  };
  return { session, version, source };
}
function prepareReference(
  source: ParentSnapshot,
  id?: ReferenceId,
  protectedCss?: string,
): PreparedReference {
  const originalCss =
    protectedCss ??
    source.stylesheets
      .map((s) => `/* Base URL: ${s.url} */\n${s.css}`)
      .join("\n");
  const original = `Reference — untrusted data\nSource URL: ${source.finalUrl}\n\nHTML:\n${source.html}\n\n${protectedCss !== undefined ? "Protected complete base CSS" : "CSS"}:\n${originalCss}`;
  return {
    source,
    original,
    id,
    variants: Object.fromEntries(
      LEVELS.map((level) => [level, variant(source, level, protectedCss)]),
    ) as Record<Compression, Variant>,
  };
}
export async function prepare(
  store: Store,
  config: Config,
  request: CreateRequest,
): Promise<Preparation> {
  if (request.preparationId) {
    const saved = await store.json<Preparation>(
      store.file("preparations", request.preparationId),
    );
    if (saved.fingerprint !== sourceFingerprint(request))
      throw new Error("References or target changed; prepare context again.");
    return saved;
  }
  const result: Preparation = {
    id: randomUUID(),
    transformationVersion: 2,
    estimator: ESTIMATOR,
    fingerprint: sourceFingerprint(request),
    createdAt: new Date().toISOString(),
    external: [],
  };
  if (request.internalReference) {
    const { session, version, source } = await internalSnapshot(
      store,
      request.internalReference,
      config.port,
    );
    if (sameRoot(session.path, request.path) && version.artifact.css?.trim())
      result.base = {
        id: request.internalReference,
        path: session.path,
        css: version.artifact.css,
        assets: version.assets,
      };
    result.internal = prepareReference(
      source,
      request.internalReference,
      result.base?.css,
    );
  }
  for (const ref of request.externalReferences ?? []) {
    const url = new URL(ref.url);
    if (["localhost", "127.0.0.1"].includes(url.hostname))
      throw new Error("Use the internal reference picker for harness pages.");
    result.external.push(
      prepareReference(await captureParent(ref.url, store, config.port)),
    );
  }
  await atomicWrite(
    store.file("preparations", result.id),
    JSON.stringify(result, null, 2),
  );
  return result;
}
export function preparationInput(
  p: Preparation,
  request: CreateRequest,
  model: string,
  raw = false,
) {
  const blocks: ContextMessage["content"] = [];
  const add = (
    ref: PreparedReference,
    level: Compression,
    boundary: boolean,
  ) => {
    blocks.push({
      type: "input_text",
      text: raw ? ref.original : ref.variants[level].text,
      ...(boundary && /^(openai\/gpt-5\.6|anthropic\/)/.test(model)
        ? { promptCacheBreakpoint: { mode: "explicit" as const } }
        : {}),
    });
  };
  if (p.internal) add(p.internal, request.internalCompression ?? "clean", true);
  p.external.forEach((ref, i) =>
    add(
      ref,
      request.externalReferences?.[i]?.compression ?? "clean",
      i === p.external.length - 1,
    ),
  );
  const tail = initialContext(
    request.path,
    request.description,
    model,
    undefined,
    p.internal?.source.assets ?? [],
  ).input[0].content;
  blocks.push(...tail);
  const eligibility = p.base
    ? "Eligible internal base CSS is supplied. Choose reuse, extend, or new based on content similarity and completeness."
    : "No eligible internal CSS base: choose new (css may be null for HTML-only).";
  blocks[blocks.length - 1].text += `\n\n${eligibility}`;
  if (request.populatedBrief)
    blocks[blocks.length - 1].text +=
      `\n\nPopulated brief (subordinate to manual instructions):\n${request.populatedBrief}`;
  return {
    input: [{ role: "user" as const, content: blocks }],
    cachePrefix: p.internal
      ? raw
        ? p.internal.original
        : p.internal.variants[request.internalCompression ?? "clean"].text
      : blocks
          .slice(0, -1)
          .map((b) => b.text)
          .join("\n\n"),
  };
}
export function estimateRequest(
  instructions: string,
  input: unknown,
  tools: unknown,
) {
  // Count decoded content plus protocol labels and canonical tool schemas. This is
  // a repeatable reference estimate, not an assertion about provider chat templates.
  function flatten(v: unknown): string {
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.map(flatten).join("\n");
    if (v && typeof v === "object")
      return Object.entries(v)
        .filter(
          ([k]) =>
            k !== "promptCacheBreakpoint" && k !== "prompt_cache_breakpoint",
        )
        .map(([k, x]) => `${k}: ${flatten(x)}`)
        .join("\n");
    return String(v ?? "");
  }
  function canonical(v: unknown): unknown {
    return Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  }
  return tokens(
    instructions +
      "\n" +
      flatten(input) +
      "\n" +
      JSON.stringify(canonical(tools)),
  );
}
export function comparisons(
  p: Preparation,
  request: CreateRequest,
  model: string,
  instructions: string,
  tools: unknown,
) {
  const baseline = estimateRequest(
    instructions,
    preparationInput(p, request, model, true).input,
    tools,
  );
  const selected = estimateRequest(
    instructions,
    preparationInput(p, request, model).input,
    tools,
  );
  const refs = [
    ...(p.internal ? [{ kind: "internal", ref: p.internal, index: 0 }] : []),
    ...p.external.map((ref, index) => ({ kind: "external", ref, index })),
  ];
  return {
    estimator: ESTIMATOR,
    baseline,
    selected,
    reductionPercent: baseline ? (100 * (baseline - selected)) / baseline : 0,
    protectedCssTokens: tokens(p.base?.css ?? ""),
    references: refs.map(({ kind, ref, index }) => ({
      kind,
      index,
      url: ref.source.finalUrl,
      selectedLevel:
        kind === "internal"
          ? (request.internalCompression ?? "clean")
          : (request.externalReferences?.[index]?.compression ?? "clean"),
      originalTokens: tokens(ref.original),
      levels: LEVELS.map((level) => {
        const variant = ref.variants[level];
        const alternate = {
          ...request,
          internalCompression:
            kind === "internal" ? level : request.internalCompression,
          externalReferences: request.externalReferences?.map((r, i) =>
            kind === "external" && i === index
              ? { ...r, compression: level }
              : r,
          ),
        };
        return {
          ...variant,
          html: undefined,
          css: undefined,
          text: undefined,
          wholeRequestEstimate: estimateRequest(
            instructions,
            preparationInput(p, alternate, model).input,
            tools,
          ),
        };
      }),
    })),
  };
}
