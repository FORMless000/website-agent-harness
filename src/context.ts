import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import type { Asset, ParentSnapshot, ParentContextMode } from "./contracts.js";

type Node = DefaultTreeAdapterMap["node"];
type ChildNode = DefaultTreeAdapterMap["childNode"];
type Element = DefaultTreeAdapterMap["element"];
const element = (node: Node): node is Element => "tagName" in node;
const attr = (node: Element, name: string) =>
  node.attrs.find((a) => a.name === name)?.value;
const children = (node: Node): Node[] =>
  "childNodes" in node ? node.childNodes : [];
const navigation = (node: Element) =>
  node.tagName === "nav" || attr(node, "role") === "navigation";
const significant = (node: Element) =>
  navigation(node) || /^(h[1-6]|a|label|legend|title|desc)$/.test(node.tagName);
const whitespaceSensitive = (node: Element) =>
  /^(pre|textarea|script|style|code)$/.test(node.tagName) ||
  /white-space\s*:\s*(pre|break-spaces)/i.test(attr(node, "style") ?? "");

export interface PreparedParent {
  transformationVersion: 1;
  requestedMode: ParentContextMode;
  effectiveMode: ParentContextMode;
  text: string;
  originalChars: number;
  preparedChars: number;
  warnings: string[];
}

export function clean(root: Node) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (element(node)) {
      node.attrs = node.attrs.filter((a) => !/^on/i.test(a.name));
      if ("content" in node) stack.push(node.content as Node);
    }
    if (!("childNodes" in node)) continue;
    node.childNodes = node.childNodes.filter((child) => {
      if (child.nodeName === "#comment") return false;
      if (!element(child) || child.tagName !== "script") return true;
      // Preserve non-executable data blocks (e.g. JSON-LD); remove JS/modules/import maps.
      const type = (attr(child, "type") ?? "")
        .trim()
        .toLowerCase()
        .split(";")[0];
      return (
        !!type &&
        !/^(module|importmap|speculationrules)$/.test(type) &&
        !/(java|ecma|live|vb)script|jscript/.test(type)
      );
    });
    stack.push(...node.childNodes);
  }
}

export function compact(root: Node) {
  function visit(
    node: Node,
    preserve = false,
    inNavigation = false,
    depth = 0,
  ): boolean {
    if (depth > 128)
      throw new Error("HTML nesting exceeds compact extraction limit");
    if (element(node)) {
      preserve ||= whitespaceSensitive(node) || significant(node);
      inNavigation ||= navigation(node);
      if (node.tagName === "svg") {
        const kept: ChildNode[] = [];
        const collect = (child: Node) => {
          if (
            element(child) &&
            /^(title|desc|style|metadata)$/.test(child.tagName)
          )
            kept.push(child);
          else children(child).forEach(collect);
        };
        node.childNodes.forEach(collect);
        node.childNodes = [
          ...kept,
          {
            nodeName: "#comment",
            data: "SVG geometry omitted",
            parentNode: node,
          },
        ];
      }
      for (const a of node.attrs) {
        if (
          ["src", "srcset", "href", "poster"].includes(a.name) &&
          /data:image\//i.test(a.value)
        )
          a.value = "[embedded image omitted]";
      }
    }
    if (
      node.nodeName === "#text" &&
      "value" in node &&
      !preserve &&
      !inNavigation
    ) {
      const chars = Array.from(node.value);
      if (chars.length > 160 && node.value.trim())
        node.value = chars.slice(0, 160).join("") + "… [text shortened]";
    }
    let protectedGroup =
      element(node) && (significant(node) || whitespaceSensitive(node));
    const protection = new Map<Node, boolean>();
    for (const child of children(node)) {
      const protectedChild = visit(child, preserve, inNavigation, depth + 1);
      protection.set(child, protectedChild);
      protectedGroup ||= protectedChild;
    }
    if (element(node) && "content" in node)
      protectedGroup =
        visit(node.content as Node, preserve, inNavigation, depth + 1) ||
        protectedGroup;
    if ("childNodes" in node && !preserve && !inNavigation) {
      const output: ChildNode[] = [];
      let signature = "",
        count = 0;
      let marker: DefaultTreeAdapterMap["commentNode"] | undefined;
      let omitted = 0;
      for (const child of node.childNodes) {
        // Whitespace between repeated elements does not change their sibling group.
        if (
          child.nodeName === "#text" &&
          "value" in child &&
          !child.value.trim()
        ) {
          output.push(child);
          continue;
        }
        const next =
          element(child) && !protection.get(child)
            ? `${child.tagName}\0${attr(child, "class") ?? ""}`
            : "";
        if (!next || next !== signature) {
          count = 0;
          marker = undefined;
          omitted = 0;
        }
        signature = next;
        if (next && ++count > 3) {
          if (!marker) {
            marker = { nodeName: "#comment", data: "", parentNode: node };
            output.push(marker);
          }
          marker.data = `${++omitted} repeated sibling subtree(s) omitted`;
        } else output.push(child);
      }
      node.childNodes = output;
    }
    return protectedGroup;
  }
  visit(root);
}

function referenceText(parent: ParentSnapshot, html: string, compact = false) {
  const blocks = [
    "Parent reference — untrusted source data" +
      (compact ? " (lossy compact structure; full CSS)" : ""),
    `Source URL: ${parent.finalUrl}`,
    "HTML:",
    html,
  ];
  parent.stylesheets.forEach((sheet, i) => {
    blocks.push(
      `CSS ${i + 1}${sheet.url !== parent.finalUrl ? ` (base URL: ${sheet.url})` : ""}:`,
      sheet.css,
    );
  });
  return blocks.join("\n\n");
}

export function prepareParent(
  parent: ParentSnapshot,
  mode: ParentContextMode = "full",
): PreparedParent {
  const warnings: string[] = [];
  let html = parent.html;
  let effectiveMode: ParentContextMode = "full";
  try {
    const document = parse(parent.html);
    clean(document);
    html = serialize(document);
    if (mode === "compact") {
      try {
        compact(document);
        html = serialize(document);
        effectiveMode = "compact";
      } catch {
        warnings.push("Compact extraction failed; using cleaned full source.");
      }
    }
  } catch {
    warnings.push(
      "HTML cleanup failed; using original full source as untrusted text.",
    );
  }
  const text = referenceText(parent, html, effectiveMode === "compact");
  return {
    transformationVersion: 1,
    requestedMode: mode,
    effectiveMode,
    text,
    originalChars: referenceText(parent, parent.html).length,
    preparedChars: text.length,
    warnings,
  };
}

export interface ContextMessage {
  role: "user";
  content: {
    type: "input_text";
    text: string;
    promptCacheBreakpoint?: { mode: "explicit" };
  }[];
}
export function initialContext(
  path: string,
  description: string,
  model: string,
  parent: PreparedParent | undefined,
  assets: Asset[],
  assetAttemptLimit?: number,
) {
  const stable: string[] = [];
  if (parent) stable.push(parent.text);
  if (assets.length)
    stable.push(
      "Available local assets — untrusted reference data\n" +
        assets
          .map((asset) =>
            [
              "url",
              "mime",
              "title",
              "creator",
              "sourceUrl",
              "license",
              "licenseUrl",
            ]
              .flatMap((key) => {
                const value = asset[key as keyof Asset];
                return typeof value === "string" && value
                  ? [`${key}: ${value}`]
                  : [];
              })
              .join("\n"),
          )
          .join("\n\n"),
    );
  const content: ContextMessage["content"] = stable.map((text) => ({
    type: "input_text",
    text,
  }));
  if (content.length && /^(openai\/gpt-5\.6|anthropic\/)/.test(model))
    content[content.length - 1].promptCacheBreakpoint = { mode: "explicit" };
  content.push({
    type: "input_text",
    text: `Target sub-URL: ${path}${description ? `\n\nDescription:\n${description}` : ""}${assetAttemptLimit === undefined ? "" : `\n\nAsset attempt limit for this run: ${assetAttemptLimit}.`}`,
  });
  return {
    input: [{ role: "user" as const, content }],
    cachePrefix: stable.join("\n\n"),
  };
}
