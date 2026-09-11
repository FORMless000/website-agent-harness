import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { z } from "zod";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const assetModeSchema = z.enum([
  "none",
  "openverse",
  "generated",
  "both",
]);
export type AssetMode = z.infer<typeof assetModeSchema>;
export interface Config {
  root: string;
  dataDir: string;
  port: number;
  assets: AssetMode;
  apiKey: string;
  imageModel: string;
  maxAssets: number;
  maxSteps: number;
  timeoutMs: number;
}
export function loadConfig(overrides: Partial<Config> = {}): Config {
  try {
    loadEnvFile(path.join(ROOT, ".env"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const integer = (value: string | undefined, fallback: number) =>
    z.coerce
      .number()
      .int()
      .positive()
      .parse(value ?? fallback);
  return {
    root: ROOT,
    dataDir: path.join(ROOT, "data"),
    port: integer(process.env.HARNESS_PORT, 8787),
    assets: assetModeSchema.parse(process.env.HARNESS_ASSETS ?? "none"),
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    imageModel: process.env.HARNESS_IMAGE_MODEL ?? "openai/gpt-5-image",
    maxAssets: integer(process.env.HARNESS_MAX_ASSETS_PER_RUN, 4),
    maxSteps: integer(process.env.HARNESS_MAX_STEPS, 8),
    timeoutMs: integer(process.env.HARNESS_RUN_TIMEOUT_MS, 600_000),
    ...overrides,
  };
}
export function publicConfig(config: Config) {
  const { apiKey: _key, dataDir: _dir, root: _root, ...safe } = config;
  return { ...safe, keyConfigured: Boolean(config.apiKey) };
}
