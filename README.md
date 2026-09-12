# Vibenet — website agent harness

A small, local research harness for generating and iterating on toy websites. New implementation; the previous `progressively-materialized-web-poc` is not used or modified.

Uses **OpenRouter Agent SDK 0.11.0**, its compatible client, TypeScript, a Node HTTP server, and a plain HTML/CSS/JS control interface. Generated websites themselves are **HTML/CSS only**, with optional local raster images or inline SVG. No framework build or generated JavaScript.

## Run

Requires Node **20.20+** and npm. Dependencies are pinned in `package-lock.json`.

```sh
cd /Users/accessair/Desktop/Workspaces/vibenet/website-agent-harness
npm ci
```

Create `.env` using `.env.example` as the template and set `OPENROUTER_API_KEY` locally. **Rotate the key previously pasted into chat**; it has not been embedded in this project. Keep `.env` out of source control and never paste credentials into generation prompts. Environment variables override `.env`.

```sh
npm start -- --assets none
```

Open [the workspace](http://127.0.0.1:8787/_harness/). The server deliberately binds only to `127.0.0.1`, not the LAN or the public internet. An API key is not needed to open the interface or inspect saved experiments; generation requires one.

Asset mode is fixed when starting the server:

```sh
npm start -- --assets openverse
npm start -- --assets generated
npm start -- --assets both
```

Only run one server for a data directory. `--port 8788` changes its port. The service owns no external deployment and makes no API calls merely to serve a generated URL. Visiting an unknown URL returns 404.

## CLI

Keep the server running in one terminal. In another:

```sh
npm run harness -- create --path /the-last-bookshop --model 1 \
  --description "An eccentric bookshop at the end of the universe"

npm run harness -- create --path /the-last-bookshop/catalog --model 3 \
  --parent http://127.0.0.1:8787/the-last-bookshop \
  --description "The shop's unusual catalog"

npm run harness -- sessions
npm run harness -- chat SESSION_ID
npm run harness -- edit SESSION_ID --message "Make it a spare black-and-white broadsheet"
npm run harness -- trace RUN_ID --json
npm run harness -- models
```

`create` asks for missing path/model interactively; noninteractive use requires both. Descriptions are open-ended: topics, layouts, fiction, formats, and aesthetic instructions. No site-category menu or built-in design template constrains the model. Provider safety rules and the HTML/CSS execution policy still apply.

`chat` supports `/history` and `/quit`. Pressing Ctrl-C while following a run requests cancellation. `--json` emits every trace event as JSONL. Use `--port` with client commands if the server uses another port.

### Explicit model choice

There is **no default model**. Choose one before creating each session; the choice is fixed for that session.

| Number | Model                | OpenRouter ID                   |
| ------ | -------------------- | ------------------------------- |
| 1      | Claude Opus 5        | `anthropic/claude-opus-5`       |
| 2      | GPT-5.6 Sol          | `openai/gpt-5.6-sol`            |
| 3      | GPT-5.6 Luna         | `openai/gpt-5.6-luna`           |
| 4      | GLM 5.3              | `z-ai/glm-5.3`                  |
| 5      | DeepSeek V4 Pro 0813 | `deepseek/deepseek-v4-pro-0813` |

Every run checks the live OpenRouter catalog for the exact slug, reasoning, tools, tool choice, and structured-output support. Unknown or unavailable capabilities fail explicitly; there is no silent model substitution. High reasoning effort is the default; available choices come from catalog metadata when provided. An advertised capability is **not** an empirical reliability score or a guarantee that a provider route currently works.

## Generation and editing

1. Record the path, optional description, and optional parent-source snapshot.
2. Snapshot the editable prompt files, model capabilities, startup configuration, and exact input.
3. Send the complete SDK conversation to OpenRouter, requesting reasoning and strict tool schemas.
4. Execute enabled asset tools or validate `submit_website` arguments. Rejections return explicit diagnostics for repair.
5. On acceptance, write an immutable version and atomically update the session's published-version pointer. Later edits submit a complete replacement, not a patch.

The transport schema is `{ "schemaVersion": 1, "html": "<!doctype html>…", "css": "…" }`; `css` may be `null`. It is strict, with no extra fields. HTML includes an explicit doctype, html/head/body/title, and closing tags. CSS goes in the separate field, not a style tag. The original artifact and served HTML are both inspectable. The served document adds the stylesheet and Openverse attribution.

The harness owns the manual-tool loop around the SDK. In installed SDK 0.11.0, automatic `stopWhen` evaluation occurs after a follow-up inference; the explicit loop avoids paying for that extra request after acceptance. SDK state serialization preserves reasoning items, including opaque provider fields, unchanged. Every tool call receives a result, including rejection, interruption recovery, and skipped calls after acceptance.

No application-level token budget, output-token cap, truncation, compaction, or history deletion is configured. Provider context/output limits, balance limits, and pricing still apply. Long sessions resend retained history and full artifacts and can become expensive or exceed model context. The default **8 model steps**, **10-minute run deadline**, and **4 image import/generation attempts per run** are operational limits, not token caps. HTTP/source/image byte limits also apply. Change environment settings in `.env.example` to experiment.

## Inspect and edit

The browser provides saved sessions, chat, live sandboxed preview, immutable historical versions, raw/served source, model-visible reasoning/text, complete outbound request bodies, tool calls/results, validation feedback, provider token/cost reports, and SDK state. The timeline renders the last 300 events for responsiveness; the download and stored JSONL retain every event. Not all providers expose reasoning text. Opaque reasoning is retained, not decrypted, and hidden internal thoughts are not available.

Edit prompts directly in `prompts/`, or use **Edit system prompts** in the browser:

- `system.md`: common generation contract and broad creative guidance.
- `initial-generation.md`: new-page generation.
- `edit-generation.md`: full-replacement editing and preservation.
- `assets.md`: asset tool guidance.

Composition is `system.md` + the applicable generation/edit file + `assets.md`. All four remain readable; only the applicable three are sent. Edits affect future runs, including future turns in existing sessions. Hash checks reject conflicting browser saves. Prompt edits do not bypass the validator or enable tools that were disabled at server startup. No prompt interpolation executes code.

## Parent sources and images

Local parent URLs at this server's origin resolve directly to the stored artifact/version and its assets. Public parent URLs capture up to 1 MiB of HTML and up to 1 MiB total of the first eight direct same-origin CSS links. JavaScript-rendered DOM, CSS imports, and third-party resources are not evaluated or crawled. Snapshots include timestamps, hashes, final URLs, and omissions/errors. Parent text and image-search metadata are treated as untrusted reference data.

### Initial context and parent modes

New sessions send common system/asset rules, then creation instructions, followed by ordered user text blocks: parent source, available assets, and finally the target path and optional description (once). Retrieval timestamps, hashes, internal IDs and asset usage stay in local records rather than model-facing text. HTML/CSS are literal text, not JSON encoded inside another string. Existing sessions and their SDK histories are not migrated or compacted; edits retain their existing behavior.

Legacy API/CLI callers can still choose **Full source** (default) or **Compact structure + full CSS** using `parentContextMode: "full" | "compact"` or `--parent-context compact`. These saved transformations are not rewritten. The current interface uses the four levels below.

- Full source removes comments, executable scripts and event attributes, while retaining declarative data and styling. HTML parser normalization may slightly increase its size.
- Compact mode additionally shortens ordinary text to 160 characters, keeps three consecutive repeated tag/class subtrees, and replaces SVG geometry/embedded image payloads with annotated placeholders. Headings, navigation, labels and whitespace-sensitive text are preserved. CSS remains complete and in source order, including inline styles. This deterministic transformation is lossy and makes no LLM call; CSS-heavy pages may see limited savings.
- Each new initial run with a parent stores a versioned `parent-context.json` alongside its trace. The original session snapshot remains intact. Extraction failures record a warning and fall back to full source. Counts include the reference labels/URLs and use JavaScript string length, not token estimates. Parent retrieval is still fresh at session creation; no network cache is introduced.

Reusable blocks precede the child-specific task. Compatible OpenAI/Anthropic requests mark a cache boundary; DeepSeek/Z.AI rely on automatic caching. Anthropic requests without a reference enable top-level automatic caching. A content-derived `x-session-id` groups requests with the same model, instructions, tool schemas and reference for best-effort provider affinity; normal provider fallback is retained. This grouping spans sibling-page sessions, not just one harness chat. No TTL extension or provider pinning is forced.

The inspector reports the preparation mode, character counts and cache-read/write tokens supplied by the provider. Missing metrics say **not reported**. “Eligible for reuse” is not a cache-hit guarantee: minimum prefix lengths, expiry and routing still apply. No live cache-hit or latency improvement has been verified by the offline tests. See [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching).

Openverse searches request CC0 or CC BY results, then import a returned image ID's thumbnail. Attribution is inserted automatically and cannot be removed by a model's HTML edit. Search metadata can be wrong: inspect the original source and verify license/attribution terms before reusing images. Generated assets use OpenRouter's `/images` endpoint; `HARNESS_IMAGE_MODEL` defaults to `openai/gpt-5-image`. This is an additional paid call. Image tool failures are exposed to the model and trace. Both paths accept only PNG/JPEG/WebP signatures, max 10 MiB per image. This signature check is not a full image decoder or a guarantee against malformed raster files.

Public fetches reject credentials, nonstandard ports, private/loopback/special IPs, and validate and pin DNS results at every redirect. No general browsing, shell, filesystem, code execution, or arbitrary-network tool is given to the model.

## Files and safety boundaries

```text
src/                 small server, CLI, SDK loop, validation and storage modules
prompts/             editable system prompt structure
web/                 plain control-interface assets
docs/                schema research and validation notes
data/                ignored local experiment records
  sessions/<id>/     session record, SDK state, immutable versions
  runs/<id>/         status, input.json, complete events.jsonl
  assets/            imported/generated raster files
  smoke/             opt-in live model test reports
```

The model can only propose artifacts or invoke enabled image tools. Generated scripts, event handlers, executable URLs, remote resources, frames, plugins, navigation bases, and form destinations are rejected. A restrictive CSP and script-disabled iframe provide a second boundary. Inline SVG and CSS remain expressive, but this is a research prototype—not a hardened multi-user hosting service. HTML/CSS validity does not prove design quality, accessibility, factual accuracy, or browser-perfect rendering.

The control API has loopback binding, Host checks, and same-origin/custom-header write protection, but **no authentication**. Do not expose it through a tunnel or reverse proxy. Anyone/process with access to your machine may read local traces and source. `.env` is ignored; request headers are not logged; known key patterns are redacted in traces. Descriptions, parent source, image prompts, and complete conversation history are sent to the selected API provider. Failed edits preserve the published page. Interrupted runs are marked failed on server restart; a subsequent edit can continue. Never run a second server against the same data directory.

## Checks

```sh
npm run typecheck
npm test
npm run test:browser
npm run build
npm run lint
```

Browser tests require Playwright's matching Chromium (`npx playwright install chromium` if not already installed). Tests use local fixtures and mocked transport, including the **real SDK**; they do not spend API credits. See `docs/validation.md` for observed results and limitations.

To use an already-installed Chrome instead of downloading Chromium: `HARNESS_BROWSER_CHANNEL=chrome npm run test:browser`.

To explicitly spend credits on create+edit checks for all five models, with the real server running:

```sh
npm run smoke:models -- --confirm-paid
# Or one model first:
npm run smoke:models -- --confirm-paid --model 3
```

This can make up to 8 model requests per run, two runs per model, with no token/cost cap. It saves actual status/usage and immutable artifacts. It has **not** been run automatically. No claim is made yet about comparative model quality or one-shot success rates.

See [schema research](docs/schema-research.md) for alternative output formats and the rationale for this first experiment.

## Reusable styles, context preparation, and archives

### Optional description population

Enable **description population** on a new task, choose its separate model/reasoning settings, and click **Populate**. This is an explicitly paid model stage with optional web search. Review/edit its proposed brief, accept individual external-reference suggestions, then use **Prepare / compare context** and **Generate**. Nothing generates automatically. Manual Description remains separate and overrides inferred guidance when explicitly requested, by prompt instruction only; validation and network controls are unchanged.

The population agent receives only the destination path, manual instructions, referring URL, neighboring page descriptions, and `world-knowledge.json` (an editable array of strings, initially empty), plus optional search results. Neighbors are active pages under the same first path segment and the exact selected reference even if archived. It never receives internal HTML/CSS or chat histories. **Allow internal-reference change suggestions** defaults off; accepting a suggestion changes only the generation reference, not the recorded referring page. New still uses the existing ancestor default until actual click-through generation is implemented.

New-session submissions include a description of the actual generated page in the same model call, saved per version. Existing versions get blank metadata sidecars under `data/descriptions/` when the harness enumerates descriptions, without rewriting artifacts or making summary calls. Legacy sessions retain their old submission contract. Hover over internal-reference options for descriptions; the selected published version shows its description directly.

Population attempts and downloadable request/response/search traces live under `data/populations/`, including failed and cancelled attempts. Generation records link back to the attempt and its accepted brief/references. Search uses OpenRouter's Exa server tool, limited by `HARNESS_POPULATION_SEARCHES` (default 2) and `HARNESS_POPULATION_SEARCH_RESULTS` (default 5, maximum 25). Search is offered on the initial request only; repairs cannot start fresh searches. Proposed URLs must appear in provider-reported successful search sources. If source URLs are not exposed, the agent must omit references and report that limitation. The installed SDK requires transport-level insertion of the documented `max_uses` field; this is included in captured outgoing requests.

API: `POST /api/populations` takes `path`, optional `description`, nullable `internalReference`, `allowReferenceSuggestions`, `model`, and `effort`; it returns an attempt `id`. `GET /api/populations/:id` returns status/result; `/events` streams events, `/trace` downloads the record and events, and `POST .../cancel` cancels it. Session creation accepts optional `populationId` and `populatedBrief`. A changed destination or manual instruction invalidates association with the old attempt. No new CLI population command or automatic click-through generation is included.

Population/search usage is separate from website usage. Missing provider metrics remain unknown. Offline tests do not establish live quality, latency, pricing, search-source coverage, or provider search-limit enforcement.

New tasks use an optional **Internal reference** (an exact stored session/version) and an ordered list of **External references**. Each has an independent Clean, Structure-preserving, Relevant subset, or Design/content brief selector; Clean is the default. New from a displayed version selects its oldest resolvable generation ancestor. Missing records and cycles produce warnings, never a URL-based replacement.

**Prepare / compare context** captures references and compares all four deterministic transformations without calling an LLM. Generation reuses that preparation; **Refresh references** explicitly recaptures it. Changing a source invalidates preparation. Originals, variants, omission reports, and warnings live under `data/preparations/`. Estimates use pinned `js-tiktoken@1.0.21` with `o200k_base`, not model-specific billing counts; provider input/cache usage is displayed separately and missing metrics remain “not reported.” Relevant CSS filtering is conservative, not exact unused-CSS detection. Brief mode is inspiration, not reproducible CSS. Failed extraction falls back with a warning.

Only the selected internal reference can supply inherited CSS, and only when its original path shares the target's first segment. Its complete resolved CSS is protected from compression and counted once. In the ordinary website submission, the model chooses `reuse`, `extend`, or `new`, with a short rationale. Extensions follow the pinned base without cascade-layer wrapping. Edits replace the whole page-specific extension; they do not repeatedly append patches. The **CSS decision** summary shows the accepted choice, rationale, base version, and authored/resolved sizes. Downloadable traces contain `style.decision` for every attempted submission, including validation failures. These are explicit explanations, not hidden reasoning. Rules remain editable in `prompts/style-decision.md`.

Use **Archive selected version & release URL** beside version controls to archive exactly the selected version. The entire session becomes read-only and retains all history/assets. Its served URL is `/_archive/<sessionId>/<versionId><originalPath>`; the original path becomes available to a new session. Navigation still targets the original site's locations, not frozen archive copies. Archived sessions remain inspectable and selectable as references through the Archived/All filters. Active runs cannot be archived. No existing data is migrated or deleted.

```sh
npm run harness -- prepare --path /tomorrow/astro --model 1 --internal SESSION_ID/VERSION_ID --internal-level relevant --external https://example.org --external-level brief
npm run harness -- create --path /tomorrow/astro --model 1 --internal SESSION_ID/VERSION_ID --internal-level relevant --external https://example.org --external-level brief --preparation PREPARATION_ID
npm run harness -- archive SESSION_ID --version VERSION_ID
```

API: `POST /api/prepare` accepts the creation fields and returns `preparationId` plus comparisons. Creation accepts `internalReference: {sessionId, versionId}`, `internalCompression`, ordered `externalReferences: [{url, compression}]`, and optional `preparationId`. Level values are `clean`, `structure`, `relevant`, `brief`. Do not mix these with legacy parent fields. `POST /api/sessions/:id/archive` takes `{versionId}`. `GET /api/bootstrap?filter=active|archived|all` filters sessions (default all for compatibility).

Interactive generated widgets, search behavior, and language switching are not implemented. No paid generation or live cache/quality experiment is part of these changes.
