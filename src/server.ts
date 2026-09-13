import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { Interactions, StaleInteraction } from "./interactions.js";
import type { Version } from "./contracts.js";
import type { InteractionDriver } from "./interaction-agent.js";
import { AutomaticPages } from "./automatic.js";
import { settingsSchema } from "./settings.js";
import { requireCapability } from "./models.js";
import { Harness } from "./harness.js";
import { MODEL_REGISTRY } from "./models.js";
import { publicConfig } from "./config.js";
import { normalizePath, referenceIdSchema } from "./contracts.js";
import { parse, serialize } from "parse5";
import { walk } from "./network.js";
import { redact } from "./agent.js";
import { SITE_CSP } from "./validation.js";
import { indexDescriptions } from "./descriptions.js";

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
function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
function rebaseNavigation(html: string, pagePath: string, origin: string) {
  const document = parse(html);
  // Only navigation is rebased; immutable artifacts and the generated CSP stay intact.
  walk(document, (node) => {
    if (!("tagName" in node) || !["a", "area"].includes(node.tagName)) return;
    for (const attribute of node.attrs) {
      if (attribute.name !== "href" || attribute.value.startsWith("#"))
        continue;
      try {
        const resolved = new URL(attribute.value, origin + pagePath);
        attribute.value =
          resolved.origin === origin
            ? resolved.pathname + resolved.search + resolved.hash
            : resolved.href;
      } catch {}
    }
  });
  return serialize(document);
}
function eligibleNavigation(request: IncomingMessage, route: string) {
  const destination = request.headers["sec-fetch-dest"];
  if (destination && !["document", "iframe"].includes(String(destination)))
    return false;
  if (
    /prefetch|prerender/i.test(
      String(request.headers.purpose ?? "") +
        String(request.headers["sec-purpose"] ?? ""),
    )
  )
    return false;
  if (
    request.headers.accept &&
    !/text\/html|\*\/\*/i.test(request.headers.accept)
  )
    return false;
  return !/\.(?:css|js|mjs|map|json|xml|txt|ico|png|jpe?g|gif|webp|svg|avif|woff2?|ttf|mp[34]|webm|pdf)$/i.test(
    route,
  );
}
async function loadingPage(
  harness: Harness,
  response: ServerResponse,
  pagePath: string,
  attempt: {
    id: string;
    status: string;
    startedAt?: string;
    finishedAt?: string;
  } | null,
  iframe: boolean,
) {
  const failed = !attempt || attempt.status === "failed";
  response.setHeader(
    "Content-Security-Policy",
    DASHBOARD_CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
  );
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  let html = await readFile(
    path.join(harness.config.root, "web", "loading.html"),
    "utf8",
  );
  html = html
    .replace("__ATTEMPT__", escapeHtml(attempt?.id ?? ""))
    .replace("__STARTED__", escapeHtml(attempt?.startedAt ?? ""))
    .replace("__FINISHED__", escapeHtml(attempt?.finishedAt ?? ""))
    .replace("__PROGRESS__", failed ? "hidden" : "")
    .replace("__STATUS__", failed ? "failed" : "running")
    .replace("__MESSAGE__", failed ? "Unable to load this page" : "Loading…")
    .replace("__RETRY__", attempt && failed && !iframe ? "" : "hidden")
    .replace(
      "__FALLBACK__",
      iframe
        ? `<p><a href="${escapeHtml(pagePath)}" target="_blank" rel="noopener">Open page</a></p>`
        : `<noscript><p><a href="${escapeHtml(pagePath)}">Reload page</a></p></noscript>`,
    );
  if (iframe)
    html = html.replace(
      '<script type="module" src="/_settings/loading.js"></script>',
      failed ? "" : '<meta http-equiv="refresh" content="2">',
    );
  response.statusCode = attempt ? 200 : 503;
  response.end(html);
}
export function createHttpServer(
  harness: Harness,
  automatic = new AutomaticPages(harness),
  interactions = new Interactions(harness),
) {
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
      const sendPage = async (
        version: Version,
        sessionId: string,
        pagePath: string,
        html: string,
      ) => {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Referrer-Policy", "same-origin");
        if (!version.artifact.regions?.length) {
          response.setHeader("Content-Security-Policy", SITE_CSP);
          response.end(html);
          return;
        }
        const bootstrap = await interactions.create(
          sessionId,
          pagePath,
          version,
        );
        const nonce = randomBytes(24).toString("base64");
        response.setHeader(
          "Content-Security-Policy",
          SITE_CSP.replace("script-src 'none'", `script-src 'nonce-${nonce}'`)
            .replace("connect-src 'none'", "connect-src 'self'")
            .replace("frame-src 'none'", "frame-src 'self'")
            .replace(
              "sandbox allow-same-origin",
              "sandbox allow-same-origin allow-scripts",
            ),
        );
        const data = JSON.stringify({
          ...bootstrap,
          regions: bootstrap.regions.map(({ id, purpose }) => ({
            id,
            purpose,
          })),
        }).replace(/</g, "\\u003c");
        response.end(
          html.replace(
            /<\/body\s*>/i,
            `<script id="harness-regions" type="application/json" nonce="${nonce}">${data}</script><script nonce="${nonce}" src="/_harness/regions.js"></script></body>`,
          ),
        );
      };
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
        "/_settings": ["settings.html", "text/html"],
        "/_settings/": ["settings.html", "text/html"],
        "/_settings/settings.js": ["settings.js", "text/javascript"],
        "/_settings/settings.css": ["settings.css", "text/css"],
        "/_settings/loading.js": ["loading.js", "text/javascript"],
        "/_settings/progress.js": ["progress.js", "text/javascript"],
        "/_harness/": ["index.html", "text/html"],
        "/_harness": ["index.html", "text/html"],
        "/_harness/app.js": ["app.js", "text/javascript"],
        "/_harness/population.js": ["population.js", "text/javascript"],
        "/_harness/style.css": ["style.css", "text/css"],
        "/_harness/regions.js": ["regions.js", "text/javascript"],
        "/_harness/region-frame.js": ["region-frame.js", "text/javascript"],
      };
      if (staticFiles[route] && method === "GET") {
        const [file, mime] = staticFiles[route];
        response.setHeader("Content-Type", `${mime}; charset=utf-8`);
        response.end(
          await readFile(path.join(harness.config.root, "web", file)),
        );
        return;
      }
      if (route === "/api/settings" && method === "GET")
        return json(response, {
          ...(await automatic.settings.get()),
          models: MODEL_REGISTRY,
          ...(await automatic.settings.resources()),
        });
      const regionFrame =
        /^\/api\/region-(frame|script)\/([\w-]+)\/([\w-]+)$/.exec(route);
      if (regionFrame && method === "GET") {
        const [, kind, visitId, regionId] = regionFrame;
        const { history, current } = await interactions.get(visitId, regionId);
        if (kind === "script") {
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.end(history.definition.javascript ?? "");
          return;
        }
        const nonce = randomBytes(24).toString("base64");
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader(
          "Content-Security-Policy",
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src http://${host} data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`,
        );
        const data = JSON.stringify({
          visitId,
          id: regionId,
          state: current.state,
          revision: current.revision,
        }).replace(/</g, "\\u003c");
        response.end(
          `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(history.definition.purpose)}</title><style>html,body{margin:0}#region-root{display:flow-root}</style><style id="region-style">${current.css ?? ""}</style></head><body><div id="region-root">${current.html}</div><script id="harness-region" type="application/json" nonce="${nonce}">${data}</script><script nonce="${nonce}" src="/_harness/region-frame.js"></script>${history.definition.javascript ? `<script nonce="${nonce}" src="/api/region-script/${visitId}/${regionId}"></script>` : ""}</body></html>`,
        );
        return;
      }
      const regionInteraction =
        /^\/api\/interactions\/([\w-]+)\/([\w-]+)(\/navigate)?$/.exec(route);
      if (regionInteraction && method === "POST") {
        const [, visitId, regionId, navigate] = regionInteraction;
        if (navigate) {
          const destination = await interactions.navigation(
            visitId,
            regionId,
            await body(request),
          );
          const existing = await harness.store.byPath(destination.path);
          if (!existing?.currentVersion) {
            const attempt = await automatic.ensure(
              destination.path,
              `http://${host}/api/preview/${destination.visit.sessionId}/${destination.visit.versionId}`,
              undefined,
              destination.description,
            );
            if (!attempt)
              return json(
                response,
                { error: "Automatic generation is disabled." },
                503,
              );
          }
          return json(response, { url: destination.path });
        }
        return json(
          response,
          await interactions.transition(visitId, regionId, await body(request)),
        );
      }
      if (route === "/api/settings" && method === "PUT") {
        const input = z
          .object({ settings: settingsSchema, revision: z.string() })
          .strict()
          .parse(await body(request));
        if (input.settings.enabled) {
          const catalog = await harness.capabilities();
          requireCapability(
            catalog,
            input.settings.websiteModel,
            input.settings.websiteEffort,
          );
          requireCapability(
            catalog,
            input.settings.interactionModel,
            input.settings.interactionEffort,
          );
          if (input.settings.descriptionEnabled)
            requireCapability(
              catalog,
              input.settings.descriptionModel,
              input.settings.descriptionEffort,
            );
        }
        return json(response, await automatic.settings.save(input));
      }
      if (route === "/api/automatic" && method === "GET")
        return json(
          response,
          redact(await automatic.list(), harness.config.apiKey),
        );
      const automaticRoute =
        /^\/api\/automatic\/([\w-]+)(?:\/(status|retry))?$/.exec(route);
      if (automaticRoute) {
        const record = await automatic.get(automaticRoute[1]);
        if (method === "GET")
          return json(
            response,
            automaticRoute[2] === "status"
              ? await automatic.progress(record.id)
              : redact(record, harness.config.apiKey),
          );
        if (method === "POST" && automaticRoute[2] === "retry") {
          const next = await automatic.ensure(
            record.path,
            record.referringUrl,
            record.id,
          );
          return json(
            response,
            next
              ? { id: next.id, status: next.status }
              : { error: "Automatic generation is disabled." },
            next ? 202 : 503,
          );
        }
      }
      if (route === "/api/bootstrap" && method === "GET")
        return json(response, {
          config: publicConfig(harness.config),
          models: MODEL_REGISTRY,
          descriptions: await indexDescriptions(harness.store),
          sessions: await Promise.all(
            (await harness.store.sessions())
              .filter((session) => {
                const filter = url.searchParams.get("filter") ?? "all";
                return filter === "archived"
                  ? !!session.archived
                  : filter === "active"
                    ? !session.archived
                    : true;
              })
              .map(async (session) => {
                const runId = session.runs.at(-1);
                const run = runId
                  ? await harness.store
                      .run(runId)
                      .catch((error: NodeJS.ErrnoException) => {
                        if (error.code === "ENOENT") return undefined;
                        throw error;
                      })
                  : undefined;
                return {
                  ...session,
                  lastRun: run
                    ? {
                        status: run.status,
                        startedAt: run.startedAt,
                        finishedAt: run.finishedAt,
                      }
                    : null,
                };
              }),
          ),
          active: [...harness.active.values()].map((a) => a.runId),
        });
      if (route === "/api/models" && method === "GET")
        return json(response, await harness.capabilities());
      if (route === "/api/populations" && method === "POST")
        return json(
          response,
          await harness.populations.start(await body(request)),
          202,
        );
      const populationRoute =
        /^\/api\/populations\/([\w-]+)(?:\/(events|trace|cancel))?$/.exec(
          route,
        );
      if (populationRoute) {
        const [, id, action] = populationRoute;
        if (method === "POST" && action === "cancel") {
          harness.populations.active.get(id)?.abort();
          return json(response, { cancelled: true });
        }
        const record = await harness.populations.get(id);
        if (method === "GET" && !action)
          return json(response, redact(record, harness.config.apiKey));
        if (method === "GET" && action === "trace") {
          response.setHeader(
            "Content-Disposition",
            `attachment; filename="population-${id}.json"`,
          );
          return json(response, {
            record: redact(record, harness.config.apiKey),
            events: await harness.populations.events(id),
          });
        }
        if (method === "GET" && action === "events") {
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          });
          let last = Number(request.headers["last-event-id"] ?? 0),
            closed = false,
            busy = false;
          const poll = async () => {
            if (closed || busy) return;
            busy = true;
            try {
              for (const event of await harness.populations.events(id))
                if (event.seq > last) {
                  last = event.seq;
                  response.write(
                    `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`,
                  );
                }
              const current = await harness.populations.get(id);
              if (current.status !== "running") {
                // Also finish clients after restart or between record save and final-event append.
                response.write(
                  `data: ${JSON.stringify({ seq: last + 1, at: current.finishedAt, type: "population.end", data: redact(current, harness.config.apiKey) })}\n\n`,
                );
                response.end();
              }
            } catch {
              response.end();
            } finally {
              busy = false;
            }
          };
          const timer = setInterval(() => void poll(), 500);
          response.on("close", () => {
            closed = true;
            clearInterval(timer);
          });
          await poll();
          return;
        }
      }
      if (route === "/api/prepare" && method === "POST")
        return json(
          response,
          await harness.prepareContext(await body(request)),
        );
      if (route === "/api/ancestor" && method === "POST")
        return json(
          response,
          await harness.oldestAncestor(
            referenceIdSchema.parse(await body(request)),
          ),
        );
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
        /^\/api\/sessions\/([\w-]+)(?:\/(turns|versions|state|archive)(?:\/([\w-]+))?)?$/.exec(
          route,
        );
      if (sessionRoute) {
        const [, id, kind, versionId] = sessionRoute;
        if (method === "POST" && kind === "archive") {
          const input = z
            .object({ versionId: z.string().regex(/^[\w-]+$/) })
            .strict()
            .parse(await body(request));
          return json(response, await harness.archive(id!, input.versionId));
        }
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
        response.setHeader("Referrer-Policy", "same-origin");
        const session = await harness.store.session(previewRoute[1]!);
        await sendPage(
          version,
          session.id,
          session.path,
          rebaseNavigation(version.servedHtml, session.path, `http://${host}`),
        );
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
      if (method === "GET" && route.startsWith("/_archive/")) {
        const match = /^\/_archive\/([\w-]+)\/([\w-]+)(\/.*)$/.exec(
          decodeURI(route),
        );
        if (!match)
          return json(response, { error: "Invalid archive URL" }, 404);
        const session = await harness.store.session(match[1]);
        if (!session.archived || session.archived.url !== decodeURI(route))
          return json(response, { error: "Archive not found" }, 404);
        const version = await harness.store.version(match[1], match[2]);
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Content-Security-Policy", SITE_CSP);
        response.setHeader("Referrer-Policy", "same-origin");
        await sendPage(
          version,
          session.id,
          session.path,
          rebaseNavigation(version.servedHtml, session.path, `http://${host}`),
        );
        return;
      }
      if (
        method === "GET" &&
        !/^\/(api|_harness|_settings|_assets|_archive)(\/|$)/.test(route)
      ) {
        const session = await harness.store.byPath(normalizePath(route));
        if (session?.currentVersion) {
          const version = await harness.store.version(
            session.id,
            session.currentVersion,
          );
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.setHeader("Content-Security-Policy", SITE_CSP);
          response.setHeader("Referrer-Policy", "same-origin");
          await sendPage(version, session.id, session.path, version.servedHtml);
          return;
        }
        if (eligibleNavigation(request, route)) {
          const attempt = await automatic.ensure(
            normalizePath(route),
            request.headers.referer ?? null,
          );
          await loadingPage(
            harness,
            response,
            normalizePath(route),
            attempt,
            request.headers["sec-fetch-dest"] === "iframe",
          );
          return;
        }
      }
      json(
        response,
        {
          error: "Not found.",
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
        error instanceof StaleInteraction
          ? 409
          : (error as NodeJS.ErrnoException).code === "ENOENT"
            ? 404
            : 400,
      );
    }
  });
}

// One server per data directory; a live PID is never displaced. Stale locks
// from a crashed process can be reclaimed, but old session data is retained.
export async function serve(
  harness: Harness,
  interactionDriver?: InteractionDriver,
) {
  const collisions = (await harness.store.sessions()).filter(
    (s) => !s.archived && /^\/(_archive|_settings)(\/|$)/.test(s.path),
  );
  if (collisions.length)
    throw new Error(
      `Reserved namespace conflicts with existing pages: ${collisions.map((s) => s.path).join(", ")}. Resolve explicitly before starting.`,
    );
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
  const automatic = new AutomaticPages(harness);
  const server = createHttpServer(
    harness,
    automatic,
    new Interactions(harness, interactionDriver),
  );
  try {
    await harness.store.recoverInterrupted();
    await automatic.initialize();
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
      await automatic.close();
      for (const active of harness.active.values())
        active.controller.abort(new Error("Server shutting down."));
      await Promise.allSettled([...harness.active.values()].map((a) => a.done));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(lock);
    },
  };
}
