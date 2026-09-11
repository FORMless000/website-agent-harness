import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, hash } from "./store.js";
export const PROMPT_NAMES = [
  "system.md",
  "initial-generation.md",
  "edit-generation.md",
  "assets.md",
] as const;
export class Prompts {
  private saving = false;
  constructor(private root: string) {}
  private file(name: string) {
    if (!(PROMPT_NAMES as readonly string[]).includes(name))
      throw new Error("Unknown prompt source");
    return path.join(this.root, "prompts", name);
  }
  async list() {
    return Promise.all(
      PROMPT_NAMES.map(async (name) => {
        const content = await readFile(this.file(name), "utf8");
        return { name, content, sha256: hash(content) };
      }),
    );
  }
  async save(name: string, content: string, expectedHash: string) {
    if (this.saving)
      throw new Error("Prompt write in progress; reload and retry.");
    this.saving = true;
    try {
      if (hash(await readFile(this.file(name), "utf8")) !== expectedHash)
        throw new Error("Prompt changed on disk; reload before saving.");
      await atomicWrite(this.file(name), content);
    } finally {
      this.saving = false;
    }
  }
}
