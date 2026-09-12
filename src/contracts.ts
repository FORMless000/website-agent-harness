import { z } from "zod";
import { effortSchema } from "./models.js";

export function normalizePath(value: string): string {
  const raw = value.trim();
  if (
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    /[?#\\\x00-\x20]/.test(raw)
  )
    throw new Error(
      "Use an absolute sub-URL path without query, fragment, whitespace, or backslashes.",
    );
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new Error("Invalid path encoding.");
  }
  if (/[?#%\\\x00-\x20\x7f]/.test(decoded))
    throw new Error("Unsafe encoded path.");
  if (
    /%2f/i.test(raw) ||
    decoded.split("/").some((p) => p === "." || p === "..")
  )
    throw new Error("Path traversal or encoded slash is not allowed.");
  const result = decoded.replace(/\/+$/, "");
  if (
    !result ||
    result.includes("//") ||
    /^\/(?:_harness|_settings|_assets|_archive|api)(?:\/|$)/.test(result)
  )
    throw new Error("This path is reserved; choose a non-root page path.");
  return result;
}
export const artifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    html: z
      .string()
      .min(1)
      .describe("Complete HTML5 document; no scripts or remote resources."),
    css: z
      .string()
      .nullable()
      .describe(
        "Optional complete CSS stylesheet, or null. Do not wrap in style tags.",
      ),
  })
  .strict();
export type Artifact = z.infer<typeof artifactSchema>;
export const styledArtifactSchema = artifactSchema
  .extend({
    schemaVersion: z.literal(2),
    style: z
      .object({
        mode: z.enum(["reuse", "extend", "new"]),
        rationale: z.string().min(1).max(1000),
      })
      .strict(),
  })
  .strict();
export type StyledArtifact = z.infer<typeof styledArtifactSchema>;
export const describedArtifactSchema = styledArtifactSchema.extend({
  schemaVersion: z.literal(3),
  pageDescription: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Concise description of the submitted page's subject, purpose, content, visual identity and principal navigation; describe the actual page, not the requested brief.",
    ),
});
export const compressionSchema = z.enum([
  "clean",
  "structure",
  "relevant",
  "brief",
]);
export type Compression = z.infer<typeof compressionSchema>;
export const referenceIdSchema = z
  .object({
    sessionId: z.string().regex(/^[\w-]+$/),
    versionId: z.string().regex(/^[\w-]+$/),
  })
  .strict();
export type ReferenceId = z.infer<typeof referenceIdSchema>;
export interface StyleRecord {
  mode: "reuse" | "extend" | "new";
  rationale: string;
  authoredCss: string | null;
  resolvedCss: string | null;
  base?: ReferenceId;
}
export const parentContextModeSchema = z.enum(["full", "compact"]);
export type ParentContextMode = z.infer<typeof parentContextModeSchema>;
export const createSchema = z
  .object({
    path: z.string().transform(normalizePath),
    description: z.string().default(""),
    populatedBrief: z.string().default(""),
    populationId: z
      .string()
      .regex(/^[\w-]+$/)
      .optional(),
    parentUrl: z.string().default(""),
    parentContextMode: parentContextModeSchema.optional(),
    model: z.union([z.string(), z.number()]),
    effort: effortSchema.default("high"),
    internalReference: referenceIdSchema.nullable().optional(),
    internalCompression: compressionSchema.optional(),
    externalReferences: z
      .array(
        z
          .object({
            url: z.string().url(),
            compression: compressionSchema.default("clean"),
          })
          .strict(),
      )
      .optional(),
    preparationId: z
      .string()
      .regex(/^[\w-]+$/)
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      (v.parentUrl || v.parentContextMode !== undefined) &&
      (v.internalReference !== undefined ||
        v.internalCompression !== undefined ||
        v.externalReferences !== undefined ||
        v.preparationId)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Use legacy parentUrl/parentContextMode or new reference fields, not both.",
      });
  })
  .transform((v) => ({
    ...v,
    parentContextMode: v.parentContextMode ?? "full",
  }));
export interface ParentSnapshot {
  url: string;
  finalUrl: string;
  capturedAt: string;
  html: string;
  stylesheets: {
    url: string;
    sourceUrl?: string;
    css: string;
    sha256: string;
  }[];
  sha256: string;
  warnings: string[];
  localVersion?: string;
  assets?: Asset[];
}
export interface Asset {
  id: string;
  url: string;
  mime: string;
  bytes: number;
  source: "generated" | "openverse";
  title?: string;
  creator?: string;
  sourceUrl?: string;
  license?: string;
  licenseUrl?: string;
  prompt?: string;
  model?: string;
  usage?: unknown;
}
export interface Version {
  pageDescription?: string;
  style?: StyleRecord;
  generationParent?: ReferenceId;
  id: string;
  runId: string;
  createdAt: string;
  artifact: Artifact;
  servedHtml: string;
  assets: Asset[];
}
export interface Session {
  submissionVersion?: 3;
  populationId?: string;
  populatedBrief?: string;
  contextVersion?: 1 | 2;
  preparationId?: string;
  referenceRequest?: z.infer<typeof createSchema>;
  generationParent?: ReferenceId;
  archived?: { at: string; versionId: string; url: string };
  parentContextMode?: ParentContextMode;
  id: string;
  path: string;
  description: string;
  model: string;
  effort: z.infer<typeof effortSchema>;
  createdAt: string;
  parent?: ParentSnapshot;
  currentVersion?: string;
  versions: string[];
  runs: string[];
  messages: {
    role: "user" | "assistant";
    text: string;
    runId: string;
    at: string;
  }[];
}
export interface RunEvent {
  seq: number;
  at: string;
  type: string;
  data: unknown;
}
export interface Run {
  id: string;
  sessionId: string;
  status: "running" | "success" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  error?: string;
  versionId?: string;
  steps: number;
  submissions: number;
  usage: unknown[];
}
