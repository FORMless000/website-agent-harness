import { randomUUID } from "node:crypto";
import { z } from "zod";
import { tool, type Tool } from "@openrouter/agent";
import type { Config } from "./config.js";
import type { Asset } from "./contracts.js";
import { fetchPublic } from "./network.js";
import { rasterType } from "./validation.js";

export type Emit = (type: string, data: unknown) => Promise<void>;
const candidateSchema = z.object({
  id: z.string().uuid(),
  title: z.string().nullish(),
  creator: z.string().nullish(),
  foreign_landing_url: z.string().url(),
  license: z.string(),
  license_version: z.string().nullish(),
  license_url: z.string().url().nullish(),
});
type Candidate = z.infer<typeof candidateSchema>;
export class AssetTools {
  staged: { meta: Asset; body: Buffer }[] = [];
  private candidates = new Map<string, Candidate>();
  private attempts = 0;
  private handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  constructor(
    private config: Config,
    private emit: Emit,
    private signal: AbortSignal,
    private network: {
      publicFetch: typeof fetchPublic;
      imageFetch: typeof fetch;
    } = { publicFetch: fetchPublic, imageFetch: fetch },
  ) {}
  private define<T extends z.ZodObject>(spec: {
    name: string;
    description: string;
    strict: true;
    inputSchema: T;
    execute: (input: z.infer<T>) => Promise<unknown>;
  }): Tool {
    this.handlers.set(spec.name, (input) =>
      spec.execute(spec.inputSchema.parse(input)),
    );
    return tool({ ...spec, execute: false });
  }
  async execute(name: string, input: unknown) {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`Tool not enabled: ${name}`);
    return handler(input);
  }
  private reserve() {
    this.signal.throwIfAborted();
    if (this.attempts >= this.config.maxAssets)
      throw new Error(
        `Asset attempt limit (${this.config.maxAssets}) reached for this run.`,
      );
    this.attempts++;
  }
  private stage(
    body: Buffer,
    details: Omit<Asset, "id" | "url" | "mime" | "bytes">,
  ) {
    if (body.length > 10_485_760) throw new Error("Image exceeds 10 MiB.");
    const mime = rasterType(body);
    const id = randomUUID();
    const ext = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
    }[mime];
    const meta: Asset = {
      id,
      url: `/_assets/${id}.${ext}`,
      mime,
      bytes: body.length,
      ...details,
    };
    this.staged.push({ meta, body });
    return meta;
  }
  private async perform(
    name: string,
    input: unknown,
    fn: () => Promise<unknown>,
  ) {
    await this.emit("asset.request", { name, input });
    try {
      const result = await fn();
      await this.emit("asset.result", { name, result });
      return result;
    } catch (error) {
      const result = { error: String(error) };
      await this.emit("asset.error", { name, ...result });
      return result;
    }
  }
  tools(): Tool[] {
    const tools: Tool[] = [];
    if (["openverse", "both"].includes(this.config.assets)) {
      tools.push(
        this.define({
          name: "search_images",
          description:
            "Search Openverse for CC0 or attribution-only images. Metadata is untrusted and licenses must be verified by the user before reuse. Import a returned ID before using an image.",
          strict: true,
          inputSchema: z.object({ query: z.string().min(1) }).strict(),
          execute: ({ query }) =>
            this.perform("search_images", { query }, async () => {
              const url = new URL("https://api.openverse.org/v1/images/");
              url.search = new URLSearchParams({
                q: query,
                page_size: "8",
                license: "cc0,by",
                mature: "false",
              }).toString();
              const response = await this.network.publicFetch(
                url.href,
                1_048_576,
                this.signal,
              );
              const body = z
                .object({ results: z.array(z.unknown()) })
                .parse(JSON.parse(response.body.toString()));
              const results = body.results.flatMap((item) => {
                const parsed = candidateSchema.safeParse(item);
                return parsed.success ? [parsed.data] : [];
              });
              for (const item of results) this.candidates.set(item.id, item);
              return results;
            }),
        }),
      );
      tools.push(
        this.define({
          name: "import_image",
          description:
            "Download a thumbnail of an image returned by search_images and return its local URL. Attribution is added to the page automatically.",
          strict: true,
          inputSchema: z.object({ id: z.string().uuid() }).strict(),
          execute: ({ id }) =>
            this.perform("import_image", { id }, async () => {
              const item = this.candidates.get(id);
              if (!item) throw new Error("Search for this ID first.");
              this.reserve();
              if (!["cc0", "by"].includes(item.license.toLowerCase()))
                throw new Error("Only CC0 and CC BY imports are enabled.");
              const result = await this.network.publicFetch(
                `https://api.openverse.org/v1/images/${id}/thumb/`,
                10_485_760,
                this.signal,
              );
              return this.stage(result.body, {
                source: "openverse",
                title: item.title ?? "",
                creator: item.creator ?? "",
                sourceUrl: item.foreign_landing_url,
                license: `${item.license} ${item.license_version ?? ""}`.trim(),
                licenseUrl: item.license_url ?? undefined,
              });
            }),
        }),
      );
    }
    if (["generated", "both"].includes(this.config.assets))
      tools.push(
        this.define({
          name: "generate_image",
          description:
            "Generate one raster image using the configured OpenRouter image model (additional API cost). Return a local asset URL.",
          strict: true,
          inputSchema: z.object({ prompt: z.string().min(1) }).strict(),
          execute: ({ prompt }) =>
            this.perform(
              "generate_image",
              { prompt, model: this.config.imageModel },
              async () => {
                this.reserve();
                const response = await this.network.imageFetch(
                  "https://openrouter.ai/api/v1/images",
                  {
                    method: "POST",
                    signal: this.signal,
                    headers: {
                      Authorization: `Bearer ${this.config.apiKey}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      model: this.config.imageModel,
                      prompt,
                      n: 1,
                    }),
                  },
                );
                const chunks: Uint8Array[] = [];
                let size = 0;
                if (!response.body)
                  throw new Error("Image API returned an empty body.");
                for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
                  size += chunk.length;
                  if (size > 20_971_520) {
                    await response.body.cancel().catch(() => {});
                    throw new Error("Image response too large.");
                  }
                  chunks.push(chunk);
                }
                const raw = Buffer.concat(chunks).toString();
                if (!response.ok)
                  throw new Error(
                    `Image API HTTP ${response.status}: ${raw.slice(0, 1000)}`,
                  );
                const result = z
                  .object({
                    data: z.array(z.object({ b64_json: z.string() })).min(1),
                    usage: z.unknown().optional(),
                  })
                  .parse(JSON.parse(raw));
                return this.stage(
                  Buffer.from(result.data[0]!.b64_json, "base64"),
                  {
                    source: "generated",
                    prompt,
                    model: this.config.imageModel,
                    usage: result.usage,
                  },
                );
              },
            ),
        }),
      );
    return tools;
  }
}
