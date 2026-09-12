#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig, assetModeSchema } from "./config.js";
import { Harness } from "./harness.js";
import { serve } from "./server.js";
import { MODEL_REGISTRY } from "./models.js";
import type { Run, RunEvent, Session } from "./contracts.js";

const help = `Website Agent Harness

  npm start -- [--assets none|openverse|generated|both] [--port 8787]
  npm run harness -- create --path /anything --model 1 [--description "..."] [--parent URL] [--parent-context full|compact] [--effort high]
  npm run harness -- chat SESSION_ID
  npm run harness -- edit SESSION_ID --message "..."
  npm run harness -- sessions
  npm run harness -- trace RUN_ID [--json]
  npm run harness -- models
  npm run harness -- prepare --path /root/page --model 1 [--internal SESSION/VERSION] [--external URL --external-level clean|structure|relevant|brief]
  npm run harness -- archive SESSION_ID --version VERSION_ID
  create also accepts --internal-level LEVEL, repeated --external/--external-level, and --preparation ID.

The server must be running for client commands. Model selection is required.
--json prints complete JSONL events (including provider-visible reasoning).
Prompts are editable in prompts/*.md or at http://127.0.0.1:8787/_harness/.
No application token cap or history compaction. Provider limits still apply.
`;
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      port: { type: "string" },
      assets: { type: "string" },
      path: { type: "string" },
      model: { type: "string" },
      description: { type: "string" },
      parent: { type: "string" },
      "parent-context": { type: "string" },
      internal: { type: "string" },
      "internal-level": { type: "string" },
      external: { type: "string", multiple: true },
      "external-level": { type: "string", multiple: true },
      preparation: { type: "string" },
      version: { type: "string" },
      effort: { type: "string" },
      message: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const command = positionals[0] ?? "help";
  if (values.help || command === "help") {
    stdout.write(help);
    return;
  }
  const port = values.port ? Number(values.port) : undefined;
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 1 || port > 65535)
  )
    throw new Error("Invalid port.");
  const config = loadConfig({
    ...(port ? { port } : {}),
    ...(values.assets ? { assets: assetModeSchema.parse(values.assets) } : {}),
  });
  const origin = `http://127.0.0.1:${config.port}`;
  async function api<T>(
    route: string,
    method = "GET",
    data?: unknown,
  ): Promise<T> {
    const response = await fetch(`${origin}/api${route}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Harness-Request": "1" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const result = (await response.json()) as T & { error?: string };
    if (!response.ok)
      throw new Error(result.error ?? `HTTP ${response.status}`);
    return result;
  }
  async function follow(runId: string) {
    const cancel = () => {
      void api(`/runs/${runId}/cancel`, "POST", {}).catch(() => {});
    };
    process.once("SIGINT", cancel);
    try {
      const response = await fetch(`${origin}/api/runs/${runId}/events`);
      if (!response.ok || !response.body)
        throw new Error(`Trace HTTP ${response.status}`);
      const decoder = new TextDecoder();
      let pending = "";
      let terminal: Run | undefined;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        pending += decoder.decode(chunk, { stream: true });
        let index: number;
        while ((index = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, index);
          pending = pending.slice(index + 2);
          const data = frame
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (!data) continue;
          const event = JSON.parse(data.slice(6)) as RunEvent;
          if (values.json) stdout.write(`${JSON.stringify(event)}\n`);
          else {
            const payload = event.data as Record<string, unknown>;
            const delta =
              event.type === "provider.event" &&
              typeof payload.delta === "string"
                ? payload.delta
                : undefined;
            if (delta) stdout.write(delta);
            else if (event.type !== "provider.event")
              stdout.write(`\n[${event.type}] ${JSON.stringify(event.data)}\n`);
          }
          if (event.type === "run.end") terminal = event.data as Run;
        }
      }
      if (!terminal)
        throw new Error(
          "Trace disconnected before completion; use trace RUN_ID to reconnect.",
        );
      if (terminal.status !== "success")
        throw new Error(terminal.error ?? terminal.status);
    } finally {
      process.removeListener("SIGINT", cancel);
    }
  }
  if (command === "serve") {
    const service = await serve(new Harness(config));
    stdout.write(
      `Harness: ${origin}/_harness/\nPages: ${origin}/<sub-url>\nAssets: ${config.assets}; API key ${config.apiKey ? "configured" : "not configured"}\n`,
    );
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      void service.close().catch((e) => {
        console.error(String(e));
        process.exitCode = 1;
      });
    };
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
    return;
  }
  if (command === "models") {
    stdout.write(
      MODEL_REGISTRY.map((m) => `${m.number}. ${m.label} (${m.id})`).join(
        "\n",
      ) + "\n",
    );
    stdout.write(JSON.stringify(await api("/models"), null, 2) + "\n");
    return;
  }
  if (command === "sessions") {
    const data = await api<{ sessions: Session[] }>("/bootstrap");
    stdout.write(
      data.sessions
        .map(
          (s) =>
            `${s.id}  ${s.path}  ${s.model}  ${s.versions.length} versions`,
        )
        .join("\n") + "\n",
    );
    return;
  }
  if (command === "trace") {
    if (!positionals[1]) throw new Error("Supply a run ID.");
    await follow(positionals[1]);
    return;
  }
  if (command === "archive") {
    if (!positionals[1] || !values.version)
      throw new Error("Supply session ID and --version.");
    stdout.write(
      JSON.stringify(
        await api(`/sessions/${positionals[1]}/archive`, "POST", {
          versionId: values.version,
        }),
        null,
        2,
      ) + "\n",
    );
    return;
  }
  if (command === "create" || command === "prepare") {
    let pagePath = values.path;
    let model = values.model;
    if ((!pagePath || !model) && stdin.isTTY) {
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        pagePath ??= await rl.question("Sub-URL (e.g. /a-tiny-museum): ");
        stdout.write(
          MODEL_REGISTRY.map((m) => `${m.number}. ${m.label}`).join("\n") +
            "\n",
        );
        model ??= await rl.question("Model number (required): ");
      } finally {
        rl.close();
      }
    }
    if (!pagePath || !model)
      throw new Error("Supply --path and --model (1–6).");
    const ref = values.internal?.split("/");
    if (ref && ref.length !== 2)
      throw new Error("--internal must be SESSION_ID/VERSION_ID");
    const payload = {
      path: pagePath,
      model,
      description: values.description ?? "",
      effort: values.effort ?? "high",
      ...(values.parent || values["parent-context"]
        ? {
            parentUrl: values.parent ?? "",
            parentContextMode: values["parent-context"] ?? "full",
          }
        : {}),
      ...(ref
        ? { internalReference: { sessionId: ref[0], versionId: ref[1] } }
        : {}),
      ...(values["internal-level"]
        ? { internalCompression: values["internal-level"] }
        : {}),
      ...(values.external
        ? {
            externalReferences: values.external.map((url, i) => ({
              url,
              compression: values["external-level"]?.[i] ?? "clean",
            })),
          }
        : {}),
      ...(values.preparation ? { preparationId: values.preparation } : {}),
    };
    if (command === "prepare") {
      stdout.write(
        JSON.stringify(await api("/prepare", "POST", payload), null, 2) + "\n",
      );
      return;
    }
    const result = await api<{ session: Session; run: Run }>(
      "/sessions",
      "POST",
      payload,
    );
    stdout.write(
      `Session: ${result.session.id}\nRun: ${result.run.id}\nPage: ${origin}${result.session.path}\n`,
    );
    await follow(result.run.id);
    return;
  }
  if (command === "edit" || command === "chat") {
    const id = positionals[1];
    if (!id) throw new Error("Supply a session ID.");
    if (command === "edit") {
      if (!values.message) throw new Error("Supply --message.");
      const run = await api<Run>(`/sessions/${id}/turns`, "POST", {
        message: values.message,
      });
      await follow(run.id);
      return;
    }
    const { session } = await api<{ session: Session }>(`/sessions/${id}`);
    stdout.write(
      `${session.path} · ${session.model}\n/quit to exit; /history to inspect chat.\n`,
    );
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      while (true) {
        const message = await rl.question("you> ");
        if (message === "/quit") break;
        if (message === "/history") {
          stdout.write(
            JSON.stringify(await api(`/sessions/${id}`), null, 2) + "\n",
          );
          continue;
        }
        if (!message.trim()) continue;
        try {
          const run = await api<Run>(`/sessions/${id}/turns`, "POST", {
            message,
          });
          await follow(run.id);
        } catch (error) {
          stdout.write(`${String(error)}\n`);
        }
      }
    } finally {
      rl.close();
    }
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
