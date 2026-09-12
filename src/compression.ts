import { parse, serialize, type DefaultTreeAdapterMap as Tree } from "parse5";
import * as css from "css-tree";
import { getEncoding } from "js-tiktoken";
import { clean, compact } from "./context.js";
import type { Compression, ParentSnapshot } from "./contracts.js";

export const LEVELS: Compression[] = [
  "clean",
  "structure",
  "relevant",
  "brief",
];
export const ESTIMATOR =
  "js-tiktoken@1.0.21/o200k_base/reference-v1 (estimate; provider framing excluded)";
let encoding: ReturnType<typeof getEncoding> | undefined;
export const tokens = (text: string) =>
  (encoding ??= getEncoding("o200k_base")).encode(text, [], []).length;
type Node = Tree["node"];
const kids = (n: Node): Node[] => ("childNodes" in n ? n.childNodes : []);
const elements = (root: Node): Tree["element"][] => {
  const result: Tree["element"][] = [],
    stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if ("tagName" in n) result.push(n);
    stack.push(...kids(n).slice().reverse());
  }
  return result;
};
const text = (n: Node): string =>
  "value" in n ? n.value : kids(n).map(text).join("");
const attr = (n: Tree["element"], key: string) =>
  n.attrs.find((a) => a.name === key)?.value;
export interface Variant {
  level: Compression;
  effectiveLevel: Compression;
  html: string;
  css: string;
  text: string;
  omissions: string[];
  warnings: string[];
  tokens: { html: number; css: number; total: number };
}

function relevant(root: Node, omissions: string[]) {
  const all = elements(root),
    body = all.find((n) => n.tagName === "body");
  const primary =
    all.find((n) => n.tagName === "main" || attr(n, "role") === "main") ??
    all.find((n) => n.tagName === "article") ??
    (body
      ? kids(body)
          .filter((n): n is Tree["element"] => "tagName" in n)
          .sort((a, b) => text(b).length - text(a).length)[0]
      : undefined);
  if (!primary || !body) return;
  const protectedNodes = new Set<Node>();
  for (const n of all)
    if (
      n === primary ||
      /^(title|h[1-6]|nav|style)$/.test(n.tagName) ||
      attr(n, "role") === "navigation"
    ) {
      let p: Node | null = n;
      while (p) {
        protectedNodes.add(p);
        p = "parentNode" in p ? p.parentNode : null;
      }
    }
  function prune(n: Node) {
    if (
      n === primary ||
      ("tagName" in n &&
        (n.tagName === "nav" || attr(n, "role") === "navigation"))
    )
      return;
    if (!("childNodes" in n)) return;
    n.childNodes = n.childNodes.map((child) => {
      if ("tagName" in child && !protectedNodes.has(child)) {
        omissions.push(
          `Peripheral <${child.tagName}> omitted (${text(child).length} text characters).`,
        );
        return {
          nodeName: "#comment" as const,
          data: `Peripheral ${child.tagName} omitted`,
          parentNode: n,
        };
      }
      if (protectedNodes.has(child)) prune(child);
      return child;
    });
  }
  prune(body);
}

function cssSource(
  source: string,
  root: Node,
  level: Compression,
  omissions: string[],
): string {
  let failed = false;
  const ast = css.parse(source, {
    parseCustomProperty: true,
    onParseError: () => {
      failed = true;
    },
  });
  if (failed) throw new Error("CSS parse uncertainty");
  if (level === "relevant") {
    const all = elements(root),
      tags = new Set(all.map((n) => n.tagName));
    const classes = new Set(
        all.flatMap((n) => (attr(n, "class") ?? "").split(/\s+/)),
      ),
      ids = new Set(all.map((n) => attr(n, "id")));
    css.walk(ast, {
      visit: "Rule",
      enter(node, item, list) {
        if (this.atrule && /keyframes$/i.test(this.atrule.name)) return;
        if (node.prelude.type !== "SelectorList") return;
        const selectors = node.prelude.children.toArray();
        // Only simple compound selectors can be proven absent. Preserve all dynamic,
        // relational, attribute, escaped and unknown selectors and all at-rule dependencies.
        const absent = selectors.every((s) => {
          const value = css.generate(s);
          if (!/^(?:[a-zA-Z][\w-]*|\*)?(?:[.#][\w-]+)*$/.test(value) || !value)
            return false;
          const tag = value.match(/^[a-zA-Z][\w-]*/)?.[0];
          return (
            (!!tag && !tags.has(tag)) ||
            [...value.matchAll(/\.([\w-]+)/g)].some(
              (m) => !classes.has(m[1]),
            ) ||
            [...value.matchAll(/#([\w-]+)/g)].some((m) => !ids.has(m[1]))
          );
        });
        if (absent && item && list) {
          omissions.push(`CSS selector omitted: ${css.generate(node.prelude)}`);
          list.remove(item);
        }
      },
    });
  }
  if (level !== "brief") return css.generate(ast);
  const groups = new Map<string, Map<string, number>>();
  const custom: string[] = [];
  css.walk(ast, {
    visit: "Declaration",
    enter(n) {
      const value = `${n.property}: ${css.generate(n.value)}${n.important ? " !important" : ""}`;
      if (n.property.startsWith("--")) {
        custom.push(value);
        return;
      }
      const category = /color|background|fill|stroke/.test(n.property)
        ? "palette"
        : /font|line-height|text/.test(n.property)
          ? "typography"
          : /margin|padding|gap/.test(n.property)
            ? "spacing"
            : /display|grid|flex|width|height|position/.test(n.property)
              ? "layout"
              : "components";
      const group = groups.get(category) ?? new Map<string, number>();
      group.set(value, (group.get(value) ?? 0) + 1);
      groups.set(category, group);
    },
  });
  const result = [
    "Design brief (not executable CSS)",
    "Custom properties:\n" + [...new Set(custom)].join("\n"),
  ];
  for (const [category, values] of groups) {
    const ranked = [...values].sort((a, b) => b[1] - a[1]);
    result.push(
      `${category}:\n${ranked
        .slice(0, 8)
        .map(([v, n]) => `${v} (${n} occurrences)`)
        .join("\n")}`,
    );
    if (ranked.length > 8)
      omissions.push(
        `${category}: ${ranked.length - 8} lower-frequency declaration examples omitted.`,
      );
  }
  return result.join("\n\n");
}

export function variant(
  parent: ParentSnapshot,
  level: Compression,
  protectedCss?: string,
): Variant {
  const omissions: string[] = [],
    warnings: string[] = [];
  try {
    const root = parse(parent.html);
    clean(root);
    const inline = elements(root).filter((n) => n.tagName === "style");
    const sheets: { url: string; css: string }[] = [];
    const matched = new Set<number>();
    let baseUrl = parent.finalUrl;
    const base = elements(root).find(
      (n) => n.tagName === "base" && attr(n, "href"),
    );
    if (base) baseUrl = new URL(attr(base, "href")!, baseUrl).href;
    for (const node of elements(root)) {
      let sheet: { url: string; css: string } | undefined;
      if (node.tagName === "style") sheet = { url: baseUrl, css: text(node) };
      else if (
        node.tagName === "link" &&
        (attr(node, "rel") ?? "")
          .toLowerCase()
          .split(/\s+/)
          .includes("stylesheet") &&
        attr(node, "href")
      ) {
        const href = new URL(attr(node, "href")!, baseUrl).href;
        const index = parent.stylesheets.findIndex(
          (s) => (s.sourceUrl ?? s.url) === href,
        );
        if (index >= 0) {
          matched.add(index);
          sheet = parent.stylesheets[index];
        }
      }
      if (sheet) {
        const media = attr(node, "media");
        sheets.push(
          media ? { ...sheet, css: `@media ${media}{${sheet.css}}` } : sheet,
        );
      }
    }
    // Stored generated artifacts keep their separate stylesheet after inline HTML.
    parent.stylesheets.forEach((s, i) => {
      if (!matched.has(i)) sheets.push(s);
    });
    // CSS is represented separately exactly once, including inline style blocks.
    for (const n of inline)
      if (n.parentNode)
        n.parentNode.childNodes = n.parentNode.childNodes.filter(
          (c) => c !== n,
        );
    if (level === "relevant") relevant(root, omissions);
    if (level !== "clean") {
      compact(root);
      omissions.push(
        "Ordinary text shortened to 160 characters; repeated groups retain three examples; embedded images/SVG geometry replaced with labels.",
      );
    }
    let html = serialize(root);
    if (level === "brief") {
      const all = elements(root);
      const lines = all
        .filter((n) =>
          /^(title|h[1-6]|a|main|article|section|nav|form|table|ul|ol)$/.test(
            n.tagName,
          ),
        )
        .map(
          (n) =>
            `${n.tagName}${attr(n, "href") ? ` → ${attr(n, "href")}` : ""}: ${/^(title|h[1-6]|a)$/.test(n.tagName) ? text(n).trim() : text(n).trim().slice(0, 160)}`,
        );
      html = "Content outline (lossy):\n" + lines.join("\n");
      omissions.push(
        "Detailed markup/attributes omitted; section text represented by examples; heading outline and navigation retained.",
      );
    }
    const cssText =
      protectedCss !== undefined
        ? protectedCss
        : sheets
            .map(
              (s) =>
                `/* Base URL: ${s.url} */\n${cssSource(s.css, root, level, omissions)}`,
            )
            .join("\n");
    const resultText = `Reference — untrusted data\nSource URL: ${parent.finalUrl}\n\nHTML${level === "brief" ? " outline" : ""}:\n${html}\n\n${protectedCss !== undefined ? "Protected complete base CSS" : "CSS"}:\n${cssText}`;
    return {
      level,
      effectiveLevel: level,
      html,
      css: cssText,
      text: resultText,
      omissions,
      warnings,
      tokens: {
        html: tokens(html),
        css: tokens(cssText),
        total: tokens(resultText),
      },
    };
  } catch (error) {
    const index = LEVELS.indexOf(level);
    if (index > 0) {
      const safer = variant(parent, LEVELS[index - 1], protectedCss);
      return {
        ...safer,
        level,
        warnings: [
          ...safer.warnings,
          `${level} extraction failed; using ${safer.effectiveLevel}: ${String(error)}`,
        ],
      };
    }
    const cssText =
      protectedCss ?? parent.stylesheets.map((s) => s.css).join("\n");
    const raw = `Reference — untrusted data\nSource URL: ${parent.finalUrl}\nHTML:\n${parent.html}\nCSS:\n${cssText}`;
    return {
      level,
      effectiveLevel: "clean",
      html: parent.html,
      css: cssText,
      text: raw,
      omissions: [],
      warnings: [`Cleanup failed; original source retained: ${String(error)}`],
      tokens: {
        html: tokens(parent.html),
        css: tokens(cssText),
        total: tokens(raw),
      },
    };
  }
}
