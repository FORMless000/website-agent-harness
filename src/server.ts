import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Harness } from "./harness.js";
import { MODEL_REGISTRY } from "./models.js";
import { publicConfig } from "./config.js";
import { normalizePath } from "./contracts.js";
import { redact } from "./agent.js";
import { SITE_CSP } from "./validation.js";

const DASHBOARD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_777_216) throw new Error("Request body exceeds 16 MiB.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}") as unknown;
}
function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}
export function createHttpServer(harness: Harness) {
  return createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", DASHBOARD_CSP);
    try {
      const host = request.headers.host;
      if (
        ![
          `127.0.0.1:${harness.config.port}`,
          `localhost:${harness.config.port}`,
        ].includes(host ?? "")
      )
        return json(response, { error: "Invalid Host." }, 403);
      const url = new URL(request.url ?? "/", `http://${host}`);
      const route = url.pathname;
      const method = request.method ?? "GET";
      if (!["GET", "HEAD"].includes(method)) {
        if (
          request.headers["x-harness-request"] !== "1" ||
          (request.headers.origin &&
            request.headers.origin !== `http://${host}`)
        )
          return json(response, { error: "Cross-origin write rejected." }, 403);
        if (!request.headers["content-type"]?.startsWith("application/json"))
          return json(response, { error: "Expected application/json." }, 415);
      }
      if (route === "/" && method === "GET") {
        response.writeHead(302, { Location: "/_harness/" });
        response.end();
        return;
      }
      const staticFiles: Record<string, [string, string]> = {
        "/_harness/": ["index.html", "text/html"],
        "/_harness": ["index.html", "text/html"],
        "/_harness/app.js": ["app.js", "text/javascript"],
        "/_harness/style.css": ["style.css", "text/css"],
      };
      if (staticFiles[route] && method === "GET") {
        const [file, mime] = staticFiles[route];
        response.setHeader("Content-Type", `${mime}; charset=utf-8`);
        response.end(
          await readFile(path.join(harness.config.root, "web", file)),
        );
        return;
      }
      if (route === "/api/bootstrap" && method === "GET")
        return json(response, {
          config: publicConfig(harness.config),
          models: MODEL_REGISTRY,
          sessions: await harness.store.sessions(),
          active: [...harness.active.values()].map((a) => a.runId),
        });
      if (route === "/api/models" && method === "GET")
        return json(response, await harness.capabilities());
      if (route === "/api/prompts" && method === "GET")
        return json(response, await harness.prompts.list());
      if (route.startsWith("/api/prompts/") && method === "PUT") {
        const input = z
          .object({ content: z.string(), sha256: z.string() })
          .strict()
          .parse(await body(request));
        await harness.prompts.save(
          route.slice("/api/prompts/".length),
          input.content,
          input.sha256,
        );
        return json(response, { saved: true });
      }
      if (route === "/api/sessions" && method === "POST")
        return json(response, await harness.create(await body(request)), 201);
      const sessionRoute =
        /^\/api\/sessions\/([\w-]+)(?:\/(turns|versions|state)(?:\/([\w-]+))?)?$/.exec(
          route,
        );
      if (sessionRoute) {
        const [, id, kind, versionId] = sessionRoute;
        if (method === "GET" && !kind)
          return json(response, {
            session: await harness.store.session(id!),
            activeRun: harness.active.get(id!)?.runId ?? null,
          });
        if (method === "GET" && kind === "versions" && versionId)
          return json(response, await harness.store.version(id!, versionId));
        if (method === "GET" && kind === "state")
          return json(
            response,
            await harness.store.json(
              harness.store.file("sessions", id!, "state.json"),
            ),
          );
        if (method === "POST" && kind === "turns") {
          const input = z
            .object({ message: z.string().min(1) })
            .strict()
            .parse(await body(request));
          return json(response, await harness.start(id!, input.message), 202);
        }
      }
      const previewRoute = /^\/api\/preview\/([\w-]+)\/([\w-]+)$/.exec(route);
      if (method === "GET" && previewRoute) {
        const version = await harness.store.version(
          previewRoute[1]!,
          previewRoute[2]!,
        );
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Content-Security-Policy", SITE_CSP);
        response.end(version.servedHtml);
        return;
      }
      const runRoute = /^\/api\/runs\/([\w-]+)(?:\/(events|cancel))?$/.exec(
        route,
      );
      if (runRoute) {
        const [, id, kind] = runRoute;
        if (method === "POST" && kind === "cancel") {
          harness.cancel(id!);
          return json(response, { cancelled: true });
        }
        if (method === "GET" && !kind)
          return json(response, {
            run: await harness.store.run(id!),
            events: await harness.store.events(id!),
          });
        if (method === "GET" && kind === "events") {
          await harness.store.run(id!);
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            Connection: "keep-alive",
          });
          response.flushHeaders();
          let last = Number(
            request.headers["last-event-id"] ??
              url.searchParams.get("after") ??
              0,
          );
          if (!Number.isSafeInteger(last) || last < 0) last = 0;
          let replaying = true;
          let closed = false;
          const buffered: import("./contracts.js").RunEvent[] = [];
          const send = (event: import("./contracts.js").RunEvent) => {
            if (closed || event.seq <= last) return;
            last = event.seq;
            response.write(
              `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`,
            );
            if (event.type === "run.end") response.end();
          };
          const unsubscribe = harness.subscribe(id!, (event) => {
            if (replaying) buffered.push(event);
            else send(event);
          });
          const timer = setInterval(
            () => response.write(": keepalive\n\n"),
            20_000,
          );
          response.on("close", () => {
            closed = true;
            clearInterval(timer);
            unsubscribe();
          });
          for (const event of await harness.store.events(id!)) send(event);
          replaying = false;
          for (const event of buffered) send(event);
          const record = await harness.store.run(id!);
          if (record.status !== "running" && !response.writableEnded) {
            response.write(
              `data: ${JSON.stringify({ seq: last + 1, at: record.finishedAt, type: "run.end", data: record })}\n\n`,
            );
            response.end();
          }
          return;
        }
      }
      if (
        method === "GET" &&
        /^\/_assets\/[\w-]+\.(png|jpg|webp)$/.test(route)
      ) {
        const mime = route.endsWith(".png")
          ? "image/png"
          : route.endsWith(".jpg")
            ? "image/jpeg"
            : "image/webp";
        response.setHeader("Content-Type", mime);
        response.setHeader("Content-Security-Policy", SITE_CSP);
        response.end(
          await readFile(
            path.join(harness.config.dataDir, "assets", path.basename(route)),
          ),
        );
        return;
      }
      if (method === "GET" && !/^\/(api|_harness|_assets)(\/|$)/.test(route)) {
        const session = await harness.store.byPath(normalizePath(route));
        if (session?.currentVersion) {
          const version = await harness.store.version(
            session.id,
            session.currentVersion,
          );
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.setHeader("Content-Security-Policy", SITE_CSP);
          response.end(version.servedHtml);
          return;
        }
      }
      json(
        response,
        {
          error:
            "Not found. Pages are generated only through an explicit session request.",
        },
        404,
      );
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      json(
        response,
        {
          error: redact(
            error instanceof Error ? error.message : String(error),
            harness.config.apiKey,
          ),
        },
        (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 400,
      );
    }
  });
}

// One server per data directory; a live PID is never displaced. Stale locks
// from a crashed process can be reclaimed, but old session data is retained.
export async function serve(harness: Harness) {
  await mkdir(harness.config.dataDir, { recursive: true });
  const lock = path.join(harness.config.dataDir, "server.lock");
  try {
    await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number(await readFile(lock, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error("Invalid server.lock; inspect it before removing it.");
    try {
      process.kill(pid, 0);
      throw new Error(`A process with PID ${pid} owns this data directory.`);
    } catch (check) {
      if ((check as NodeJS.ErrnoException).code !== "ESRCH") throw check;
    }
    await unlink(lock);
    await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  }
  const server = createHttpServer(harness);
  try {
    await harness.store.recoverInterrupted();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(harness.config.port, "127.0.0.1", resolve);
    });
  } catch (error) {
    await unlink(lock);
    throw error;
  }
  return {
    server,
    close: async () => {
      for (const active of harness.active.values())
        active.controller.abort(new Error("Server shutting down."));
      await Promise.allSettled([...harness.active.values()].map((a) => a.done));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(lock);
    },
  };
}
