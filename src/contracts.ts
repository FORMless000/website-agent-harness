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
    /^\/(?:_harness|_assets|api)(?:\/|$)/.test(result)
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
export const createSchema = z
  .object({
    path: z.string().transform(normalizePath),
    description: z.string().default(""),
    parentUrl: z.string().default(""),
    model: z.union([z.string(), z.number()]),
    effort: effortSchema.default("high"),
  })
  .strict();
export interface ParentSnapshot {
  url: string;
  finalUrl: string;
  capturedAt: string;
  html: string;
  stylesheets: { url: string; css: string; sha256: string }[];
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
  id: string;
  runId: string;
  createdAt: string;
  artifact: Artifact;
  servedHtml: string;
  assets: Asset[];
}
export interface Session {
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
