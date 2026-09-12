import path from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { assetModeSchema, publicConfig, type Config } from "./config.js";
import { compressionSchema } from "./contracts.js";
import { effortSchema, resolveModel } from "./models.js";
import { atomicWrite, hash } from "./store.js";

const model = z.string().refine((id) => {
  try {
    resolveModel(id);
    return true;
  } catch {
    return false;
  }
}, "Choose a registered model.");
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const settingsSchema = z
  .object({
    enabled: z.boolean(),
    descriptionEnabled: z.boolean(),
    websiteModel: model,
    websiteEffort: effortSchema,
    descriptionModel: model,
    descriptionEffort: effortSchema,
    searchEnabled: z.boolean(),
    internalCompression: compressionSchema,
    externalCompression: compressionSchema,
    assets: assetModeSchema,
    imageModel: z.string().trim().min(1),
    maxAssets: positive,
    maxSteps: positive,
    timeoutMs: positive.max(2_147_483_647),
    populationSearches: positive,
    populationSearchResults: positive.max(25),
  })
  .strict();
export type AutomaticSettings = z.infer<typeof settingsSchema>;
export function defaultSettings(config: Config): AutomaticSettings {
  return {
    enabled: true,
    descriptionEnabled: true,
    searchEnabled: true,
    websiteModel: "deepseek/deepseek-v4.1-flash",
    websiteEffort: "low",
    descriptionModel: "deepseek/deepseek-v4.1-flash",
    descriptionEffort: "low",
    internalCompression: "clean",
    externalCompression: "clean",
    assets: config.assets,
    imageModel: config.imageModel,
    maxAssets: config.maxAssets,
    maxSteps: config.maxSteps,
    timeoutMs: config.timeoutMs,
    populationSearches: config.populationSearches,
    populationSearchResults: config.populationSearchResults,
  };
}
export function executionConfig(
  config: Config,
  settings: AutomaticSettings,
): Config {
  const {
    assets,
    imageModel,
    maxAssets,
    maxSteps,
    timeoutMs,
    populationSearches,
    populationSearchResults,
  } = settings;
  return {
    ...config,
    assets,
    imageModel,
    maxAssets,
    maxSteps,
    timeoutMs,
    populationSearches,
    populationSearchResults,
  };
}
export class Settings {
  private saving = false;
  private file: string;
  constructor(private config: Config) {
    this.file = path.join(config.dataDir, "automatic-settings.json");
  }
  async get() {
    let settings: AutomaticSettings;
    try {
      settings = settingsSchema.parse(
        JSON.parse(await readFile(this.file, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      settings = defaultSettings(this.config);
    }
    return { settings, revision: hash(JSON.stringify(settings)) };
  }
  async save(value: unknown) {
    const input = z
      .object({ settings: settingsSchema, revision: z.string() })
      .strict()
      .parse(value);
    if (this.saving)
      throw new Error("Settings save in progress; reload and retry.");
    this.saving = true;
    try {
      if ((await this.get()).revision !== input.revision)
        throw new Error("Settings changed; reload before saving.");
      await atomicWrite(this.file, JSON.stringify(input.settings, null, 2));
      return this.get();
    } finally {
      this.saving = false;
    }
  }
  async resources() {
    const location = path.join(this.config.root, "world-knowledge.json");
    let content = "[]";
    try {
      content = await readFile(location, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return {
      worldKnowledge: { location, content },
      startup: publicConfig(this.config),
    };
  }
}
