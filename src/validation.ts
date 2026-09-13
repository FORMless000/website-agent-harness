import { parse as parseHtml, parseFragment } from "parse5";
import * as cssTree from "css-tree";
import { artifactSchema, type Artifact, type Asset } from "./contracts.js";
import { walk } from "./network.js";

export const SITE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-same-origin";
export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function rasterType(
  body: Buffer,
): "image/png" | "image/jpeg" | "image/webp" {
  if (
    body.length >= 24 &&
    body
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    body.toString("ascii", 12, 16) === "IHDR"
  )
    return "image/png";
  if (body.length >= 4 && body[0] === 255 && body[1] === 216 && body[2] === 255)
    return "image/jpeg";
  if (
    body.length >= 16 &&
    body.toString("ascii", 0, 4) === "RIFF" &&
    body.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  throw new Error(
    "Only PNG, JPEG, or WebP raster signatures are accepted (not SVG or HTML downloads).",
  );
}
function navigation(value: string) {
  if (/[\x00-\x20\\]/.test(value)) return false;
  if (
    value.startsWith("#") ||
    (value.startsWith("/") &&
      !value.startsWith("//") &&
      !/^\/(?:api|_harness)(?:\/|$)/.test(value))
  )
    return true;
  try {
    const url = new URL(value);
    return (
      ["https:", "http:", "mailto:", "tel:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
export function validateArtifact(
  input: unknown,
  assets: Asset[],
): { artifact?: Artifact; errors: string[] } {
  const parsed = artifactSchema.safeParse(input);
  if (!parsed.success)
    return {
      errors: parsed.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`,
      ),
    };
  const artifact = parsed.data;
  const errors: string[] = [];
  const resources = new Set(assets.map((a) => a.url));
  const resource = (value: string) => {
    if (resources.has(value) || /^#[a-zA-Z_][\w:.-]*$/.test(value)) return true;
    const match =
      /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(
        value,
      );
    if (!match) return false;
    try {
      return rasterType(Buffer.from(match[2]!, "base64")) === match[1];
    } catch {
      return false;
    }
  };
  const checkCss = (source: string, inline = false) => {
    if (/<\/style/i.test(source))
      errors.push("CSS cannot contain a closing style tag.");
    try {
      const ast = cssTree.parse(source, {
        context: inline ? "declarationList" : "stylesheet",
        parseCustomProperty: true,
        positions: true,
        onParseError: (e) => errors.push(`CSS: ${e.message}`),
      });
      cssTree.walk(ast, (node) => {
        if (node.type === "Raw") errors.push("CSS contains unparsed syntax.");
        if (node.type === "Url" && !resource(node.value))
          errors.push(
            `CSS resource is not an approved local asset: ${node.value.slice(0, 120)}`,
          );
        if (
          node.type === "Atrule" &&
          [
            "import",
            "font-face",
            "namespace",
            "document",
            "-moz-document",
          ].includes(node.name.toLowerCase())
        )
          errors.push(`CSS @${node.name} is not supported.`);
        if (
          node.type === "Function" &&
          ["expression", "image-set", "-webkit-image-set"].includes(
            node.name.toLowerCase(),
          )
        )
          errors.push(
            `CSS ${node.name}() is not supported; use url() for approved images.`,
          );
        if (
          node.type === "Declaration" &&
          /^(?:behavior|-moz-binding)$/i.test(node.property)
        )
          errors.push(`Unsupported CSS property: ${node.property}`);
        if (
          node.type === "Declaration" &&
          !node.property.startsWith("--") &&
          cssTree.generate(node.value).trim() === ""
        )
          errors.push(`CSS ${node.property} has an empty value.`);
      });
    } catch (error) {
      errors.push(`CSS: ${String(error)}`);
    }
  };
  const doc = parseHtml(artifact.html, {
    sourceCodeLocationInfo: true,
    onParseError: (e) =>
      errors.push(`HTML ${e.code} at ${e.startLine}:${e.startCol}`),
  });
  const forbidden = new Set([
    "script",
    "style",
    "link",
    "iframe",
    "frame",
    "frameset",
    "object",
    "embed",
    "base",
    "portal",
    "foreignObject",
    "foreignobject",
    "animate",
    "animatemotion",
    "animatetransform",
    "set",
    "audio",
    "video",
    "source",
    "track",
  ]);
  const required = new Set(["html", "head", "body", "title"]);
  const mounts: string[] = [];
  let doctype = false;
  walk(doc, (node) => {
    if (node.nodeName === "#documentType") doctype = true;
    if (!("tagName" in node)) return;
    const tag = node.tagName.toLowerCase();
    const regionId = node.attrs.find((a) => a.name === "data-region-id");
    if (regionId) {
      mounts.push(regionId.value);
      if (tag !== "div") errors.push("Use a div for each region placeholder.");
      let ancestor = node.parentNode;
      while (ancestor) {
        if (ancestor.nodeName === "#document-fragment")
          errors.push("Region placeholders cannot be inside templates.");
        ancestor = "parentNode" in ancestor ? ancestor.parentNode : null;
      }
      if (
        node.childNodes.some(
          (child) =>
            child.nodeName !== "#text" ||
            ("value" in child && child.value.trim()),
        )
      )
        errors.push(
          "Region placeholders must be empty; put initial content in the region definition.",
        );
    }
    if (required.has(tag)) {
      required.delete(tag);
      if (!node.sourceCodeLocation?.startTag || !node.sourceCodeLocation.endTag)
        errors.push(`Include explicit opening and closing <${tag}> tags.`);
    }
    if (forbidden.has(tag)) errors.push(`<${tag}> is not allowed.`);
    for (const attr of node.attrs) {
      const name = attr.name.toLowerCase();
      if (
        name === "id" &&
        [
          "harness-regions",
          "harness-region",
          "region-root",
          "region-style",
        ].includes(attr.value)
      )
        errors.push(`ID ${attr.value} is reserved for the region runtime.`);
      if (
        /^on/.test(name) ||
        [
          "srcdoc",
          "action",
          "formaction",
          "ping",
          "http-equiv",
          "autofocus",
          "is",
        ].includes(name)
      )
        errors.push(`Attribute ${name} is not allowed.`);
      if (name === "style") checkCss(attr.value, true);
      if (name === "srcset" || name === "imagesrcset")
        errors.push("Use a single approved src instead of srcset.");
      if (
        ["src", "poster", "background", "data"].includes(name) &&
        !resource(attr.value)
      )
        errors.push(
          `Unapproved resource in ${name}: ${attr.value.slice(0, 120)}`,
        );
      if (name === "href") {
        const valid =
          tag === "a" && !attr.namespace
            ? navigation(attr.value)
            : resource(attr.value);
        if (!valid)
          errors.push(
            `Unsafe or unsupported href: ${attr.value.slice(0, 120)}`,
          );
      }
      if (name === "target" && !["_self", "_blank"].includes(attr.value))
        errors.push("Only _self and _blank link targets are supported.");
    }
  });
  if (!doctype) errors.push("Include <!doctype html>.");
  for (const tag of required) errors.push(`Missing <${tag}>.`);
  if (artifact.css) checkCss(artifact.css);
  const definitions = artifact.regions ?? [];
  if (new Set(definitions.map((r) => r.id)).size !== definitions.length)
    errors.push("Region IDs must be unique.");
  for (const region of definitions) {
    if (mounts.filter((id) => id === region.id).length !== 1)
      errors.push(
        `Region ${region.id} requires exactly one data-region-id placeholder.`,
      );
    errors.push(
      ...validateRegionContent(region, assets).map(
        (error) => `Region ${region.id}: ${error}`,
      ),
    );
  }
  if (mounts.some((id) => !definitions.some((r) => r.id === id)))
    errors.push("Every region placeholder requires a region definition.");
  return errors.length
    ? { errors: [...new Set(errors)] }
    : { artifact, errors: [] };
}
// Reuse the page resource/markup policy, but require a body fragment. Optional
// JavaScript is a separate immutable field and never enters host-page markup.
export function validateRegionContent(
  region: { html: string; css: string | null },
  assets: Asset[],
): string[] {
  if (/<\/?(?:html|head|body|title)\b|<!doctype/i.test(region.html))
    return ["Use an HTML body fragment, not a document."];
  if (/data-region-id\s*=/i.test(region.html))
    return ["Regions cannot contain other regions."];
  return validateArtifact(
    {
      schemaVersion: 1,
      html: `<!doctype html><html><head><title>Region</title></head><body>${region.html}</body></html>`,
      css: region.css,
    },
    assets,
  ).errors;
}

export function regionActions(html: string): Set<string> {
  const actions = new Set<string>();
  walk(parseFragment(html), (node) => {
    if (!("attrs" in node)) return;
    const action = node.attrs.find((a) => a.name === "data-region-action");
    if (action?.value) actions.add(action.value);
  });
  return actions;
}
export function renderArtifact(artifact: Artifact, assets: Asset[]) {
  let html = artifact.html;
  if (artifact.css)
    html = html.replace(
      /<\/head\s*>/i,
      `<style>${artifact.css}</style></head>`,
    );
  const credits = assets
    .filter((a) => a.source === "openverse")
    .map((a) => {
      const link = (url: string | undefined, text: string) => {
        try {
          if (url && ["https:", "http:"].includes(new URL(url).protocol))
            return `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
        } catch {
          /* Render as text. */
        }
        return escapeHtml(text);
      };
      return `<li>${link(a.sourceUrl, a.title || "Untitled")} by ${escapeHtml(a.creator || "Unknown creator")} — ${link(a.licenseUrl, a.license || "License not supplied")} (via Openverse; no endorsement implied)</li>`;
    });
  if (credits.length)
    html = html.replace(
      /<\/body\s*>/i,
      `<aside aria-label="Image credits"><h2>Image credits</h2><ul>${credits.join("")}</ul></aside></body>`,
    );
  return html;
}
