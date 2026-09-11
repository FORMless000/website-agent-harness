import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
  appendFile,
} from "node:fs/promises";
import path from "node:path";
import type { Run, RunEvent, Session, Version } from "./contracts.js";

export const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export const now = () => new Date().toISOString();
export async function atomicWrite(file: string, value: string | Uint8Array) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
}
export function safeId(id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid record ID");
  return id;
}
export class Store {
  constructor(public dir: string) {}
  file(kind: string, id: string, name = "record.json") {
    return path.join(this.dir, kind, safeId(id), name);
  }
  async json<T>(file: string): Promise<T> {
    return JSON.parse(await readFile(file, "utf8")) as T;
  }
  async saveSession(session: Session) {
    await atomicWrite(
      this.file("sessions", session.id),
      JSON.stringify(session, null, 2),
    );
  }
  session(id: string) {
    return this.json<Session>(this.file("sessions", id));
  }
  async sessions(): Promise<Session[]> {
    const dirs = await readdir(path.join(this.dir, "sessions")).catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return [];
        throw e;
      },
    );
    return (await Promise.all(dirs.map((id) => this.session(id)))).sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt),
    );
  }
  async byPath(pagePath: string) {
    return (await this.sessions()).find((s) => s.path === pagePath);
  }
  async saveRun(run: Run) {
    await atomicWrite(this.file("runs", run.id), JSON.stringify(run, null, 2));
  }
  run(id: string) {
    return this.json<Run>(this.file("runs", id));
  }
  async appendEvent(id: string, event: RunEvent) {
    await appendFile(
      this.file("runs", id, "events.jsonl"),
      `${JSON.stringify(event)}\n`,
      { mode: 0o600 },
    );
  }
  async events(id: string): Promise<RunEvent[]> {
    const content = await readFile(
      this.file("runs", id, "events.jsonl"),
      "utf8",
    ).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return "";
      throw e;
    });
    // A process crash can leave one partial final line. Complete records remain readable.
    return content
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as RunEvent];
        } catch {
          return [];
        }
      });
  }
  async saveVersion(sessionId: string, version: Version) {
    const file = this.file(
      "sessions",
      sessionId,
      `versions/${safeId(version.id)}.json`,
    );
    await mkdir(path.dirname(file), { recursive: true });
    // Immutable IDs; no replacement of older research results.
    await writeFile(file, JSON.stringify(version, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
  }
  version(sessionId: string, id: string) {
    return this.json<Version>(
      this.file("sessions", sessionId, `versions/${safeId(id)}.json`),
    );
  }
  async recoverInterrupted() {
    for (const session of await this.sessions()) {
      for (const id of session.runs) {
        const run = await this.run(id);
        if (run.status === "running") {
          Object.assign(run, {
            status: "failed",
            finishedAt: now(),
            error:
              "Server stopped during this run. Start another turn to continue.",
          });
          await this.saveRun(run);
        }
      }
    }
  }
}
