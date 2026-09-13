# Vibenet — website agent harness

A small, local research harness for generating and iterating on toy websites. New implementation; the previous `progressively-materialized-web-poc` is not used or modified.

Uses **OpenRouter Agent SDK 0.11.0**, its compatible client, TypeScript, a Node HTTP server, and a plain HTML/CSS/JS control interface. Generated page documents are **HTML/CSS**, with optional local raster images, inline SVG, and minimal interactive regions. Regions use native controls plus model-generated state transitions by default; optional initial JavaScript runs inside isolated region frames. No framework build is required.

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

Manual harness/CLI asset mode is selected when starting the server. Automatic visits initially inherit it and can override it in `/_settings`:

```sh
npm start -- --assets openverse
npm start -- --assets generated
npm start -- --assets both
```

Only run one server for a data directory. `--port 8788` changes its port. The service owns no external deployment. Published URLs serve without model calls. Visiting an unexplored page URL starts automatic generation and shows a minimal loading page; configure this behavior at [Automatic settings](http://127.0.0.1:8787/_settings).

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

Manual harness/CLI creation requires an explicit model. Automatic visits default to DeepSeek V4.1 Flash with low effort for both description and website generation; change these separately in `/_settings`. The website model is fixed for each created session, including retries.

| Number | Model                | OpenRouter ID                   |
| ------ | -------------------- | ------------------------------- |
| 1      | Claude Opus 5        | `anthropic/claude-opus-5`       |
| 2      | GPT-5.6 Sol          | `openai/gpt-5.6-sol`            |
| 3      | GPT-5.6 Luna         | `openai/gpt-5.6-luna`           |
| 4      | GLM 5.3              | `z-ai/glm-5.3`                  |
| 5      | DeepSeek V4 Pro 0813 | `deepseek/deepseek-v4-pro-0813` |
| 6      | DeepSeek V4.1 Flash  | `deepseek/deepseek-v4.1-flash`  |
| 7      | Gemini 3.8 Flash     | `google/gemini-3.8-flash`       |
| 8      | Claude Sonnet 5      | `anthropic/claude-sonnet-5`     |
| 9      | Kimi K3              | `moonshotai/kimi-k3`            |

Additional comparison candidates, selected from the live OpenRouter catalog on 2026-09-12:

- [Gemini 3.8 Flash](https://openrouter.ai/google/gemini-3.8-flash): a responsive coding/agentic alternative from Google; advertised efforts are low, medium, and high.
- [Claude Sonnet 5](https://openrouter.ai/anthropic/claude-sonnet-5): another Anthropic coding option; advertised efforts are low, medium, high, xhigh, and max.
- [Kimi K3](https://openrouter.ai/moonshotai/kimi-k3): a candidate for complex coding and long-context agentic work; advertised efforts are low, high, and max.

These are research candidates, not locally established quality rankings. All three advertise the harness's required tool calling, tool choice, reasoning, and structured outputs. Their registry entries use the existing generation and population paths. Offline compatibility checks do not establish live provider success or website quality. DeepSeek V4.1 Flash/low remains the automatic default.

Every run checks the live OpenRouter catalog for the exact slug, reasoning, tools, tool choice, and structured-output support. Unknown or unavailable capabilities fail explicitly; there is no silent model substitution. Manual creation defaults to high reasoning effort; automatic visits use low, the lowest advertised effort for DeepSeek V4.1 Flash in the [OpenRouter catalog](https://openrouter.ai/api/v1/models) verified on 2026-09-12; available choices come from catalog metadata when provided. An advertised capability is **not** an empirical reliability score or a guarantee that a provider route currently works.

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

The model can only propose artifacts or invoke enabled image tools. Scripts in generated HTML, event handlers, executable URLs, remote resources, authored frames, plugins, navigation bases, and form destinations are rejected. Static pages remain script-disabled. Interactive pages permit a nonce-authorized trusted bridge; initial region JavaScript runs only in opaque script-enabled child frames without network access or host DOM access. Inline SVG and CSS remain expressive, but this is a research prototype—not a hardened multi-user hosting service. HTML/CSS validity does not prove design quality, accessibility, factual accuracy, or browser-perfect rendering.

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

To explicitly spend credits on create+edit checks for all registered models, with the real server running:

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

The population agent receives only the destination path, manual instructions, referring URL, neighboring page descriptions, and `world-knowledge.json` (an editable array of strings, initially empty), plus optional search results. Neighbors are active pages under the same first path segment and the exact selected reference even if archived. It never receives internal HTML/CSS or chat histories. **Allow internal-reference change suggestions** defaults off; accepting a suggestion changes only the generation reference, not the recorded referring page. Manual New still uses the existing ancestor default. Automatic click-through generation pins the referring page/version instead.

New-session submissions include a description of the actual generated page in the same model call, saved per version. Existing versions get blank metadata sidecars under `data/descriptions/` when the harness enumerates descriptions, without rewriting artifacts or making summary calls. Legacy sessions retain their old submission contract. Hover over internal-reference options for descriptions; the selected published version shows its description directly.

Population attempts and downloadable request/response/search traces live under `data/populations/`, including failed and cancelled attempts. Generation records link back to the attempt and its accepted brief/references. Search uses OpenRouter's Exa server tool, limited by `HARNESS_POPULATION_SEARCHES` (default 2) and `HARNESS_POPULATION_SEARCH_RESULTS` (default 5, maximum 25). Search is offered on the initial request only; repairs cannot start fresh searches. Proposed URLs must appear in provider-reported successful search sources. If source URLs are not exposed, the agent must omit references and report that limitation. The installed SDK requires transport-level insertion of the documented `max_uses` field; this is included in captured outgoing requests.

API: `POST /api/populations` takes `path`, optional `description`, nullable `internalReference`, `allowReferenceSuggestions`, `model`, and `effort`; it returns an attempt `id`. `GET /api/populations/:id` returns status/result; `/events` streams events, `/trace` downloads the record and events, and `POST .../cancel` cancels it. Session creation accepts optional `populationId` and `populatedBrief`. A changed destination or manual instruction invalidates association with the old attempt. No CLI population command is included; automatic click-through visits call the same population and generation methods on the server.

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

Generated interactive regions support model-driven controls, including invented search suggestions and destinations. No paid generation or live cache/quality experiment is part of these changes.

## Automatic visits and live settings

An unexplored page GET starts one shared attempt per normalized path: resolve an internal reference, optionally populate a brief/search for references, then call the existing `Harness.create` flow. Visitors see “Loading…”, the current stage (description, reasoning, or final response), and an elapsed timer before the published HTML. Stages follow provider events; waiting/preparation shows “Preparing page…”. Raw reasoning and response text stay in backend traces. Failed website generation shows “Unable to load this page” and an explicit Retry button. Reloading a failure does not spend more credits. Retries preserve failed traces and reuse any existing unpublished session and its original model/conversation. Description-stage failures continue with a blank brief; rejected external captures are omitted with recorded warnings.

A local referring URL selects its published version; archive and preview URLs select their exact version. Otherwise, choose the nearest active published page by path-tree distance, preferring the same first segment, then falling back across the project. Lexical path breaks ties. Empty projects use no reference. Generated and preview responses send same-origin referrers, never external ones. Missing/hidden referrers use the neighbor fallback. The reference is pinned for the attempt, and population cannot replace it.

Root still opens the laboratory. API, harness, settings, asset, and archive namespaces are reserved. HEAD, non-GET, prefetch, non-document resource requests, and common resource-file URLs never generate pages. Query strings share the pathname's page; fragments remain browser state. Sandboxed preview loading uses a script-free fallback; open the page directly for visitor Retry controls. Generated HTML remains script-free; interactive documents additionally load the trusted region bridge.

`/_settings` configures automatic visits and interactive regions. Interaction model/effort apply to all new page visits, and the initial JavaScript preference applies to manual and automatic page generation. Main controls select generation/description/search switches and independent website/description models and efforts. Expand references, images, and advanced execution to set compression, search limits, existing image modes/model/attempt limits, model steps, and stage timeout in milliseconds. Prompts link to the existing editor; world knowledge and startup configuration are shown read-only. The initial models are DeepSeek V4.1 Flash/low, population/search are on, compression is Clean, and other execution settings inherit startup values. Disabling generation stops new attempts, not active ones or published pages.

Settings are saved atomically in `data/automatic-settings.json` with revision conflict checks. Every attempt snapshots effective settings; saving does not change active automatic attempts or existing region visits. Manual page model configuration remains separate. Invalid settings are rejected. Interrupted attempts are failed on restart and wait for explicit retry. Run only one server per data directory, as before.

`data/automatic/<id>/record.json` links path, selected reference/reason, settings, warnings, population ID, session ID and run ID. The settings page lists attempts and links existing session/trace inspectors. Population events and ordinary generation events/input snapshots remain in their existing locations. Output page descriptions are still recorded even when the input description stage is disabled.

API additions: `GET /api/settings` returns settings, revision, models, and read-only resources. `PUT /api/settings` takes `{settings, revision}` using the existing JSON/custom-header write protection. `GET /api/automatic` lists backend records; `GET /api/automatic/:id` reads one. The loading shell polls `GET /api/automatic/:id/status` (ID, status, stage and attempt timestamps only); `POST /api/automatic/:id/retry` explicitly retries a failed attempt. No new generation service, queue, deployment, or CLI workflow is introduced.

## Minimal interactive regions

Page artifacts may include `regions`: up to 16 independent definitions with `id`,
`purpose`, initial fragment `html`, nullable `css`, JSON-object `state`, and nullable
`javascript`. Each has one empty `<div data-region-id="id"></div>` in the page.
The page generator authors all initial region content in its normal submission;
opening the page makes no interaction-model call. Existing artifacts without
regions continue to work and are not rewritten.

Controls declare `data-region-action="action"`; forms submit and buttons activate
that action. Inputs explicitly opt into debounced events with
`data-region-event="input"` or `"change"`. Named control values and the region state
are sent to the independent interaction agent. Each response replaces only that
region's fragment, CSS and state. The server sends the agent its purpose, initial
JavaScript (if any), complete region history, and latest event; no surrounding page
or sibling history is included. Failed requests preserve the displayed UI.

Settings expose an interaction model and reasoning effort (default DeepSeek V4.1
Flash/low) and an initial JavaScript generation preference (default off). The
preference changes generation instructions, not validation. Initial JavaScript
can use local DOM/canvas/timers and `region.root`, `region.state`,
`region.setState(next)`, `region.dispatch(action)`, and
`region.onUpdate(callback)`. It loads once per region instance and survives
fragment replacements. Later model responses cannot include JavaScript. Use
delegated handlers on the persistent root or rebind in `onUpdate`. Region styles
are self-contained; page CSS does not cross the iframe boundary.

Every document visit gets a fresh ID; navigation back, reloads, and separate tabs
start from the published initial state. Histories and redacted request traces are
retained under `data/visits/<visit-id>/` for inspection, without compression. They
are not resumed on a new visit. Model settings are fixed for that visit.

`POST /api/interactions/:visit/:region` accepts `{revision, event: {action, inputs,
state}}`. Revisions serialize accepted updates; concurrent/stale requests receive 409. Responses contain `revision`, `html`, `css`, `state`, and `destinations`
(`{path, description}` entries). The trusted bridge alone performs API writes.
Clicking a local region link uses `POST .../navigate` with `{path}` and passes its
declared description to the existing lazy page-generation flow. Merely generating
a link does not generate its destination.
