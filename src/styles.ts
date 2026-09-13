import {
  artifactSchema,
  describedArtifactSchema,
  styledArtifactSchema,
  type Artifact,
  type StyleRecord,
  type ReferenceId,
} from "./contracts.js";
import { z } from "zod";
import { AssetTools } from "./assets.js";
import type { Config } from "./config.js";
export const SUBMIT_DESCRIPTION =
  "Validate and submit the complete replacement HTML/CSS website. If rejected, fix the returned diagnostics and submit again. A valid submission ends the run.";
export function estimationTools(config: Config, described = true) {
  const assets = new AssetTools(
    config,
    async () => {},
    new AbortController().signal,
  ).tools();
  return [
    {
      type: "function",
      name: "submit_website",
      description: SUBMIT_DESCRIPTION,
      strict: true,
      parameters: z.toJSONSchema(
        described ? describedArtifactSchema : styledArtifactSchema,
        { target: "draft-7" },
      ),
    },
    ...assets.map((t) => {
      if (!("function" in t))
        throw new Error("Unsupported tool in context estimator");
      return {
        type: "function",
        name: t.function.name,
        description: t.function.description ?? null,
        strict: t.function.strict ?? null,
        parameters: z.toJSONSchema(t.function.inputSchema, {
          target: "draft-7",
        }),
      };
    }),
  ];
}
export const STYLE_INSTRUCTIONS = `For schemaVersion 2, make the CSS decision in submit_website itself; no separate planning call. Return style.mode (reuse, extend, or new) and a short rationale. Reuse requires an eligible supplied internal base and css=null. Extend requires that base and a complete page-specific additions/overrides stylesheet, not a patch or a repeated base. New uses standalone CSS (or null for HTML-only). Judge content similarity and base completeness yourself. On edits always replace the complete authored extension. The host resolves and validates the final CSS. Internal and external references may both influence content and appearance.`;
export function resolveStyle(
  input: unknown,
  base?: { id: ReferenceId; css: string },
): { artifact: Artifact; style: StyleRecord } {
  const submitted = styledArtifactSchema.parse(input);
  const { mode, rationale } = submitted.style;
  if (mode !== "new" && !base?.css.trim())
    throw new Error("CSS reuse/extension requires an eligible internal base.");
  if (mode === "reuse" && submitted.css !== null)
    throw new Error("Reuse must use css=null.");
  if (mode === "extend" && !submitted.css?.trim())
    throw new Error("Extend requires complete additions/overrides CSS.");
  const resolvedCss =
    mode === "reuse"
      ? base!.css
      : mode === "extend"
        ? `${base!.css}\n${submitted.css}`
        : submitted.css;
  return {
    artifact: artifactSchema.parse({
      schemaVersion: 1,
      html: submitted.html,
      css: resolvedCss,
      ...(submitted.regions ? { regions: submitted.regions } : {}),
    }),
    style: {
      mode,
      rationale,
      authoredCss: submitted.css,
      resolvedCss,
      ...(mode !== "new" ? { base: base!.id } : {}),
    },
  };
}
