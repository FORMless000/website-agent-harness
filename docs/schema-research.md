# Output schema research

Research context: September 2026. This compares representational tradeoffs, not measured model accuracy. No schema expresses every possible interactive website without also introducing executable behavior. The present experiment intentionally excludes generated JavaScript.

## First implementation: a strict envelope around HTML/CSS

Use a strict tool input with `schemaVersion`, a complete `html` string, and nullable `css`. This makes the transport shape predictable while retaining HTML/CSS's layout range. A schema can constrain the envelope but cannot validate an HTML string's semantics, rendering, or safety; parsing, diagnostics, CSP, and visual checks remain separate. OpenRouter supports strict structured outputs on compatible models/providers and recommends requiring supported parameters. The harness applies those principles to strict function-tool arguments. [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)

| Candidate                                   | One-shot advantage                                                     | Expressiveness / cost                                                                                      | Decision                                               |
| ------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Raw complete HTML, inline or separate CSS   | Familiar web syntax; no renderer to invent                             | Needs document validation; free-form Markdown/code-fence outputs can break parsing                         | HTML/CSS payload, strict JSON tool envelope            |
| Strict JSON envelope containing HTML/CSS    | Small schema, stable field names, explicit versioning                  | JSON escaping adds overhead; string contents still need parsing                                            | Implemented                                            |
| DOM/element JSON tree plus style objects    | Enforces element/attribute structure before rendering                  | More tokens/nesting; tables, SVG, CSS selectors, pseudo-elements and at-rules require a sizable schema     | Possible second experiment, not implemented            |
| Catalog-driven component JSON (json-render) | Only enumerated components/props can be generated                      | Reliable renderer contracts, but designs are bounded by a chosen component catalog                         | Useful for dashboards; not the arbitrary-page baseline |
| A2UI                                        | Declarative UI descriptions with a controlled client rendering surface | Requires a compatible client/catalog and renderer; not a drop-in arbitrary HTML document                   | Useful when moving toward application UIs              |
| Markdown / frontmatter plus a template      | Concise, easy to inspect, strong for text-heavy pages                  | Arbitrary layout requires renderer extensions or raw HTML; MDX adds executable React                       | Useful content-only baseline, not implemented          |
| Full framework project / JSX                | Rich reusable components and behavior                                  | Multiple files, imports, dependency/build failures, and execution permissions complicate one-shot research | Out of scope for the minimal harness                   |

The catalog tradeoff is an inference from the designs of [json-render](https://github.com/vercel-labs/json-render) and [A2UI's protocol](https://github.com/a2ui-project/a2ui/blob/main/specification/v1_0/docs/a2ui_protocol.md): narrowing the renderable vocabulary improves structural control but necessarily bounds designs unless the catalog grows. These projects are examples to compare, not dependencies or supported output formats here.

## Agent and reasoning interface

The SDK supplies tool schemas, streaming responses, and conversation-state support. The application adds explicit per-request steps, validator feedback, image tools, and transactional publication. Its manual-tool loop is intentionally small and inspectable. [Agent SDK overview](https://openrouter.ai/docs/agent-sdk/overview), [state and tool approval](https://openrouter.ai/docs/agent-sdk/call-model/tool-approval-state), [streaming](https://openrouter.ai/docs/agent-sdk/call-model/streaming)

Reasoning support does not imply that all internal computation is exposed. Persist provider-returned reasoning items without rewriting or removing opaque fields; display whatever text/summaries are actually returned. Live catalog checks are necessary because model and provider capabilities change. [Reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens), [OpenRouter model catalog](https://openrouter.ai/api/v1/models)

## Optional images

Image generation uses the documented OpenRouter image API and adds separate model cost. Search/import uses Openverse, downloads a returned result's thumbnail, and retains source/creator/license metadata for attribution. Neither a search engine result nor its license metadata substitutes for checking the original source. [OpenRouter image generation](https://openrouter.ai/docs/guides/overview/multimodal/image-generation), [Openverse API client documentation](https://docs.openverse.org/packages/js/api_client/index.html), [Openverse terms](https://docs.openverse.org/api/reference/terms_of_service.html)

## Suggested experiments (not implemented or run)

Keep the same prompt set, model, effort, parent snapshot, and asset mode across formats. Report at least: first-submission validation success; repaired success within a fixed step count; input/output/reasoning tokens and provider-reported cost; elapsed time; browser screenshot; overflow/accessibility checks; and a blinded human rating for adherence and visual quality. Keep failed outputs, not just successful pages. Model APIs generally do not guarantee identical reruns, so preserve complete raw traces and report repeated trials rather than claiming determinism.
