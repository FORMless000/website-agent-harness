# Validation record

This file is updated after local checks. Offline fixtures are explicitly synthetic test inputs, not generated-model quality examples.

## Observed local results

Latest test/build verification: 2026-09-06. Catalog and vulnerability checks below were performed on 2026-09-05.

- Node 20.20.1; pinned dependency lockfile.
- `npm run typecheck`: passed.
- `npm test`: **14 passed**, no live API inference (real SDK with mocked transport).
- `HARNESS_BROWSER_CHANNEL=chrome npm run test:browser`: **2 passed**, desktop 1440×1080 and mobile 390×844; screenshots visually inspected. Installed Chrome was used because the matching bundled Playwright Chromium was not present. No browser download was needed.
- `npm run build` and compiled CLI help: passed.
- `npm run lint`: passed (format check; TypeScript performs static checking).
- `npm audit --omit=dev`: **0 reported runtime dependency vulnerabilities** at the time of the check. This is not a security audit.
- Real server started at `127.0.0.1:8787`, assets disabled, API key unconfigured. No model inference, image generation, or Openverse requests were performed outside mocks.
- The live, public model catalog returned all five configured model IDs with reasoning and structured/tool-output support. An optional parallel-tool-call request parameter was omitted because four of these models do not advertise it; the harness executes tools sequentially itself. This catalog check is read-only and does not establish live inference success.

Issues found and fixed during testing: SDK automatic-loop follow-up spend after acceptance (replaced with explicit manual-tool boundaries); the SDK broadcaster's late rejection handler when a trace consumer is slow (capture the SDK HTTP response stream directly instead); and a browser race when a run completed between fetching the session and fetching its run status. These have regression coverage, including an intentionally slow trace sink and repeated empty provider responses.

## Covered by automated tests

- Path normalization/reserved routes/traversal rejection.
- HTML/CSS schema and execution/resource policy, including rejected submissions.
- Private/special IP and URL policy checks.
- Startup-controlled asset-tool exposure, raster signatures, and key redaction.
- Exact model selection and explicit unsupported-capability failures.
- Real OpenRouter Agent SDK with a mocked SSE transport: rejected submission, repair, acceptance without an extra request, complete edit history, preserved opaque reasoning, strict tool arguments, disabled truncation, no output-token cap, failed-edit preservation.
- Cancellation, per-session locking, prompt-save conflicts, interrupted-run recovery.
- Local HTTP serving, protected writes/Host checking, historical preview, SSE replay, CLI listing/editing.
- Browser create/edit/preview/source/trace/prompt-edit/reload flow and mobile layout.
- Parent-source redirects, first document base URL, case-insensitive stylesheet relationships, duplicate links, cross-origin omissions, byte/count limits, and recorded source hashes. Relative parent stylesheets now honor the document base rather than incorrectly resolving against the page URL.

## Not established by offline tests

- Live inference success, design quality, or comparative reliability of the five models.
- Live OpenRouter image generation or Openverse import availability/licensing accuracy.
- JavaScript-rendered parent-page fidelity (intentionally source-only).
- A security audit, complete browser compatibility, or full image decoding validation.
- Bit-for-bit reproducibility of LLM output; the harness preserves evidence, not provider determinism.

The opt-in `smoke:models` command performs live create/edit checks and records actual results. It is not part of the default test suite and requires explicit paid-call confirmation.
