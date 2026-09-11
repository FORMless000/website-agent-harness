// Deliberately opt-in: two paid inference runs per selected model, plus repairs.
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { MODEL_REGISTRY, resolveModel } from "../src/models.js";
import type { Run, Session } from "../src/contracts.js";
const { values } = parseArgs({
  options: {
    "confirm-paid": { type: "boolean" },
    model: { type: "string" },
    port: { type: "string" },
  },
});
if (!values["confirm-paid"])
  throw new Error(
    "This test spends API credits. Start the real server, then explicitly pass --confirm-paid (optionally --model 1). No calls were made.",
  );
const config = loadConfig();
const origin = `http://127.0.0.1:${values.port ?? config.port}`;
async function api<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${origin}/api${route}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "X-Harness-Request": "1" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}
async function finish(id: string) {
  const response = await fetch(`${origin}/api/runs/${id}/events`);
  if (!response.ok) throw new Error(`Trace HTTP ${response.status}`);
  await response.text();
  return (await api<{ run: Run }>(`/runs/${id}`)).run;
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const results: unknown[] = [];
for (const model of values.model
  ? [resolveModel(values.model)]
  : MODEL_REGISTRY) {
  try {
    const result = await api<{ session: Session; run: Run }>("/sessions", {
      path: `/smoke/${stamp}/model-${model.number}`,
      model: model.number,
      description:
        "A tiny field guide to imaginary clouds. Make a responsive editorial page in HTML and CSS. Do not use image tools.",
      effort: "high",
    });
    const create = await finish(result.run.id);
    let edit: Run | undefined;
    if (create.status === "success") {
      const next = await api<Run>(`/sessions/${result.session.id}/turns`, {
        message:
          "Change the title to Cloud Cabinet and add a short section about a fictional striped cloud. Preserve the rest.",
      });
      edit = await finish(next.id);
    }
    results.push({
      model: model.id,
      sessionId: result.session.id,
      path: result.session.path,
      create,
      edit,
    });
    console.log(
      `${model.label}: create=${create.status}, edit=${edit?.status ?? "skipped"}`,
    );
  } catch (error) {
    results.push({ model: model.id, error: String(error) });
    console.error(`${model.label}: ${String(error)}`);
  }
}
const output = path.join(config.dataDir, "smoke", `${stamp}.json`);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(results, null, 2), {
  flag: "wx",
  mode: 0o600,
});
console.log(`Results: ${output}`);
if (
  results.some((result) => {
    const r = result as { error?: string; create?: Run; edit?: Run };
    return (
      r.error || r.create?.status !== "success" || r.edit?.status !== "success"
    );
  })
)
  process.exitCode = 1;
