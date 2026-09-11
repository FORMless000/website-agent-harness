import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { normalizePath, type ParentSnapshot } from "./contracts.js";
import { hash, now, type Store } from "./store.js";

export function isPublicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
export function publicUrl(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  )
    throw new Error(
      "Only public HTTP(S) URLs on standard ports are supported.",
    );
  return url;
}

// Resolve and pin the socket address on EVERY redirect, preventing private-IP
// requests and DNS rebinding. This intentionally does not use ambient proxies.
export async function fetchPublic(
  value: string,
  maxBytes: number,
  signal?: AbortSignal,
  redirects = 3,
): Promise<{ url: string; mime: string; body: Buffer }> {
  const url = publicUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    throw new Error(
      "Private, loopback, and special-purpose network addresses are blocked.",
    );
  const chosen = addresses[0]!;
  const result = await new Promise<{
    status: number;
    location?: string;
    mime: string;
    body: Buffer;
  }>((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).get(
      url,
      {
        signal: AbortSignal.any([
          AbortSignal.timeout(20_000),
          ...(signal ? [signal] : []),
        ]),
        lookup: (_name, options, callback) => {
          if (options.all) callback(null, [chosen]);
          else callback(null, chosen.address, chosen.family);
        },
        headers: {
          "User-Agent": "Vibenet-Research-Harness/0.1",
          "Accept-Encoding": "identity",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes)
            request.destroy(new Error(`Resource exceeds ${maxBytes} bytes.`));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            location: response.headers.location,
            mime: String(response.headers["content-type"] ?? "")
              .split(";")[0]!
              .toLowerCase(),
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.on("error", reject);
  });
  if ([301, 302, 303, 307, 308].includes(result.status)) {
    if (!result.location || redirects <= 0)
      throw new Error("Too many redirects or missing redirect location.");
    return fetchPublic(
      new URL(result.location, url).href,
      maxBytes,
      signal,
      redirects - 1,
    );
  }
  if (result.status < 200 || result.status >= 300)
    throw new Error(`Resource returned HTTP ${result.status}.`);
  return { url: url.href, mime: result.mime, body: result.body };
}

export type HtmlNode = DefaultTreeAdapterMap["node"];
export function walk(node: HtmlNode, visit: (node: HtmlNode) => void) {
  visit(node);
  if ("childNodes" in node)
    for (const child of node.childNodes) walk(child, visit);
  if ("content" in node) walk(node.content as HtmlNode, visit);
}

export async function captureParent(
  value: string,
  store: Store,
  port: number,
  fetcher: typeof fetchPublic = fetchPublic,
): Promise<ParentSnapshot> {
  const url = new URL(value);
  if (
    ["127.0.0.1", "localhost"].includes(url.hostname) &&
    url.protocol === "http:" &&
    url.port === String(port) &&
    !url.username &&
    !url.password
  ) {
    const session = await store.byPath(normalizePath(url.pathname));
    if (!session?.currentVersion)
      throw new Error("That local parent page has not been published.");
    const version = await store.version(session.id, session.currentVersion);
    return {
      url: value,
      finalUrl: value,
      capturedAt: now(),
      html: version.artifact.html,
      stylesheets: version.artifact.css
        ? [
            {
              url: value,
              css: version.artifact.css,
              sha256: hash(version.artifact.css),
            },
          ]
        : [],
      sha256: hash(version.artifact.html),
      warnings: [],
      localVersion: version.id,
      assets: version.assets,
    };
  }
  const response = await fetcher(value, 1_048_576);
  if (!["text/html", "application/xhtml+xml"].includes(response.mime))
    throw new Error("Parent URL must return HTML.");
  const html = response.body.toString("utf8");
  const snapshot: ParentSnapshot = {
    url: value,
    finalUrl: response.url,
    capturedAt: now(),
    html,
    stylesheets: [],
    sha256: hash(html),
    warnings: [],
  };
  const links: string[] = [];
  const document = parse(html);
  let baseUrl = response.url;
  let foundBase = false;
  // The first base href controls resolution of relative stylesheet links.
  // Its URL remains reference data; the same-origin/public-network checks apply.
  walk(document, (node) => {
    if (foundBase || !("tagName" in node) || node.tagName !== "base") return;
    const href = node.attrs.find((attr) => attr.name === "href")?.value;
    if (href === undefined) return;
    foundBase = true;
    try {
      baseUrl = new URL(href, response.url).href;
    } catch {
      snapshot.warnings.push("Invalid document base URL ignored.");
    }
  });
  walk(document, (node) => {
    if ("tagName" in node && node.tagName === "link") {
      const attrs = Object.fromEntries(
        node.attrs.map((a) => [a.name, a.value]),
      );
      if (
        attrs.rel?.toLowerCase().split(/\s+/).includes("stylesheet") &&
        attrs.href
      ) {
        try {
          links.push(new URL(attrs.href, baseUrl).href);
        } catch {
          snapshot.warnings.push("Invalid stylesheet URL omitted.");
        }
      }
    }
  });
  let remaining = 1_048_576;
  const uniqueLinks = [...new Set(links)];
  for (const link of uniqueLinks.slice(0, 8)) {
    if (remaining <= 0) {
      snapshot.warnings.push("Parent stylesheet byte limit reached.");
      break;
    }
    if (new URL(link).origin !== new URL(response.url).origin) {
      snapshot.warnings.push(`Cross-origin stylesheet omitted: ${link}`);
      continue;
    }
    try {
      const css = await fetcher(link, remaining);
      if (
        new URL(css.url).origin !== new URL(response.url).origin ||
        css.mime !== "text/css"
      )
        throw new Error("Not a same-origin CSS response.");
      remaining -= css.body.length;
      snapshot.stylesheets.push({
        url: css.url,
        css: css.body.toString("utf8"),
        sha256: hash(css.body),
      });
    } catch (error) {
      snapshot.warnings.push(`${link}: ${String(error)}`);
    }
  }
  if (uniqueLinks.length > 8)
    snapshot.warnings.push(
      "Only the first eight direct stylesheet links are captured.",
    );
  snapshot.warnings.push(
    "Source snapshot only: JavaScript, CSS imports, and remote assets are not executed or recursively fetched.",
  );
  return snapshot;
}
