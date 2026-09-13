const $ = (id) => document.getElementById(id);
let preparationId;
import { updateProgress, tick } from "/_settings/progress.js";
import { initializePopulation } from "./population.js";
const compressionLevels = [
  ["clean", "Clean"],
  ["structure", "Structure-preserving"],
  ["relevant", "Relevant subset"],
  ["brief", "Design/content brief"],
];
const fillLevels = (el) =>
  el.replaceChildren(
    ...compressionLevels.map(([v, label]) => option(v, label)),
  );
let bootstrap,
  session,
  version,
  stream,
  activeRun,
  events = [],
  prompts = [],
  catalog = [],
  view = "preview",
  inspector = "request",
  renderQueued = false;
function notice(message) {
  $("notice").textContent = message;
  $("notice").hidden = !message;
}
async function api(route, method = "GET", body) {
  const response = await fetch(`/api${route}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Harness-Request": "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}
const guarded =
  (fn) =>
  async (...args) => {
    try {
      await fn(...args);
    } catch (error) {
      notice(error.message);
    }
  };
function option(value, label) {
  const el = document.createElement("option");
  el.value = value;
  el.textContent = label;
  return el;
}
function elapsedLabel(run) {
  if (!run) return "Last run: —";
  const elapsed =
    (run.finishedAt
      ? Date.parse(run.finishedAt)
      : run.status === "running"
        ? Date.now()
        : NaN) - Date.parse(run.startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "Last run: —";
  const seconds = Math.floor(elapsed / 1000);
  const duration =
    seconds < 1
      ? "<1s"
      : seconds < 60
        ? `${seconds}s`
        : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `Last run: ${duration}${run.status === "running" ? " (running)" : ""}`;
}
async function refresh() {
  bootstrap = await api("/bootstrap");
  const selectedRef = $("internal-reference").value;
  $("internal-reference").replaceChildren(
    option("", "None"),
    ...bootstrap.sessions.flatMap((s) =>
      s.versions.map((id, i) => {
        const entry = option(
          `${s.id}/${id}`,
          `${s.path} · v${i + 1}${s.archived ? " · archived" : ""} · ${s.id.slice(0, 8)}`,
        );
        entry.title =
          bootstrap.descriptions?.find(
            (d) => d.sessionId === s.id && d.versionId === id,
          )?.pageDescription || "not described";
        return entry;
      }),
    ),
  );
  $("internal-reference").value = selectedRef;
  $("settings").textContent =
    `LOCALHOST ONLY  ·  Assets: ${bootstrap.config.assets}  ·  Max ${bootstrap.config.maxSteps} agent steps/run`;
  if (!bootstrap.config.keyConfigured)
    notice(
      "No API key configured. Set OPENROUTER_API_KEY in the ignored .env file and restart the server. Do not paste credentials into prompts.",
    );
  $("sessions").replaceChildren(
    ...bootstrap.sessions
      .filter(
        (s) =>
          $("session-filter").value === "all" ||
          !!s.archived === ($("session-filter").value === "archived"),
      )
      .map((s) => {
        const button = document.createElement("button");
        button.className = `session ${session?.id === s.id ? "active" : ""}`;
        const title = document.createElement("strong");
        title.textContent = s.path;
        const detail = document.createElement("small");
        detail.textContent = `${bootstrap.models.find((m) => m.id === s.model)?.label ?? s.model} · ${s.versions.length} versions`;
        const elapsed = document.createElement("small");
        elapsed.textContent = elapsedLabel(s.lastRun);
        elapsed.title =
          "Elapsed time of the latest website generation/edit run, updated when the session list refreshes.";
        button.append(title, detail, elapsed);
        button.onclick = guarded(() => selectSession(s.id));
        return button;
      }),
  );
}
function updateEfforts() {
  const model = bootstrap.models.find(
    (m) => String(m.number) === $("model").value,
  );
  const efforts = catalog
    .find((m) => m.id === model?.id)
    ?.reasoning?.supported_efforts?.filter((e) =>
      ["low", "medium", "high", "xhigh", "max"].includes(e),
    ) ?? ["high"];
  $("effort").replaceChildren(...efforts.map((e) => option(e, e)));
  $("effort").value = efforts.includes("high") ? "high" : efforts[0];
}
function setBusy(runId) {
  activeRun = runId;
  $("send").disabled = !!runId || !!session?.archived;
  $("archive-session").disabled =
    !!runId || !!session?.archived || !session?.currentVersion;
  $("cancel-run").hidden = !runId;
  $("run-status").textContent = runId ? "Running" : "Ready";
  $("run-status").classList.toggle("running", !!runId);
}
function drawSession() {
  $("empty").hidden = true;
  $("experiment").hidden = false;
  $("page-path").textContent = session.path;
  $("session-model").textContent =
    `${session.model} · reasoning ${session.effort}`;
  $("open-page").href = session.archived?.url ?? session.path;
  $("open-page").hidden = !session.currentVersion;
  $("messages").replaceChildren(
    ...session.messages.map((message) => {
      const item = document.createElement("div");
      item.className = "message";
      const role = document.createElement("span");
      role.className = "role";
      role.textContent = message.role;
      item.append(role, document.createTextNode(message.text));
      return item;
    }),
  );
  $("messages").scrollTop = $("messages").scrollHeight;
  $("versions").replaceChildren(
    ...session.versions.map((id, i) => option(id, `v${i + 1}`)),
  );
  $("runs").replaceChildren(
    ...session.runs.map((id, i) =>
      option(id, `Run ${i + 1} · ${id.slice(0, 8)}`),
    ),
  );
}
async function selectSession(id) {
  stream?.close();
  const data = await api(`/sessions/${id}`);
  session = data.session;
  drawSession();
  setBusy(data.activeRun);
  version = null;
  if (session.currentVersion) await selectVersion(session.currentVersion);
  else drawVersion();
  const runId = data.activeRun ?? session.runs.at(-1);
  if (runId) await selectRun(runId);
  else {
    events = [];
    $("requests").replaceChildren();
    renderTrace();
  }
  history.replaceState(null, "", `#${id}`);
  await refresh();
}
async function selectVersion(id) {
  version = await api(`/sessions/${session.id}/versions/${id}`);
  $("versions").value = id;
  drawVersion();
}
function drawVersion() {
  $("page-description").textContent =
    `Page description: ${version?.pageDescription || "not described"}`;
  const basePath = bootstrap?.sessions.find(
    (s) => s.id === version?.style?.base?.sessionId,
  )?.path;
  $("style-decision").textContent = version?.style
    ? `CSS decision: ${version.style.mode} · ${version.style.rationale}\nBase: ${version.style.base ? `${basePath ?? "page unavailable"} (${version.style.base.sessionId}/${version.style.base.versionId})` : "none"} · Authored: ${version.style.authoredCss?.length ?? 0} characters · Resolved: ${version.style.resolvedCss?.length ?? 0} characters`
    : "CSS decision not recorded for this version.";
  $("preview").hidden = !version || view !== "preview";
  $("source").hidden = !version || view === "preview";
  $("no-version").hidden = !!version;
  if (!version) {
    $("version-info").textContent = "";
    return;
  }
  $("version-info").textContent =
    ` · ${new Date(version.createdAt).toLocaleTimeString()}`;
  const url = `/api/preview/${session.id}/${version.id}`;
  if ($("preview").getAttribute("src") !== url) $("preview").src = url;
  $("source").textContent =
    view === "css"
      ? (version.artifact.css ?? "/* No separate CSS */")
      : view === "served"
        ? version.servedHtml
        : version.artifact.html;
}
async function selectRun(id) {
  stream?.close();
  const owner = session.id;
  async function finished(record) {
    if (session?.id !== owner) return;
    if (
      activeRun === id ||
      (record.versionId && !session.versions.includes(record.versionId))
    ) {
      const current = await api(`/sessions/${owner}`);
      if (session?.id !== owner) return;
      session = current.session;
      setBusy(current.activeRun === id ? null : current.activeRun);
      drawSession();
      $("runs").value = id;
      if (session.currentVersion) await selectVersion(session.currentVersion);
      await refresh();
    }
    $("run-status").textContent = record.status;
    if (record.error) notice(record.error);
  }
  events = [];
  $("requests").replaceChildren();
  $("runs").value = id;
  const data = await api(`/runs/${id}`);
  events = data.events;
  renderTrace();
  if (data.run.status === "running") {
    stream = new EventSource(
      `/api/runs/${id}/events?after=${events.at(-1)?.seq ?? 0}`,
    );
    stream.onmessage = guarded(async (message) => {
      if (session?.id !== owner) return;
      const event = JSON.parse(message.data);
      if (!events.some((e) => e.seq === event.seq)) events.push(event);
      queueRender();
      if (event.type === "run.end") {
        stream.close();
        await finished(event.data);
      }
    });
    stream.onerror = () => {
      $("run-status").textContent = "Reconnecting trace…";
    };
  } else {
    await finished(data.run);
  }
}
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderTrace();
  });
}
// Display-only notation: string blocks preserve actual whitespace without
// executing markup. Decode JSON containers, not arbitrary backslash sequences.
function readableRequest(value, depth = 0) {
  if (depth > 50) return JSON.stringify(value);
  const indent = "  ".repeat(depth);
  if (typeof value === "string") {
    if (/^\s*[\[{]/.test(value)) {
      try {
        return `[JSON string] ${readableRequest(JSON.parse(value), depth)}`;
      } catch {
        // Plain text that resembles JSON is still displayed verbatim.
      }
    }
    return `|\n${value
      .split("\n")
      .map((line) => `${indent}  ${line}`)
      .join("\n")}`;
  }
  if (value && typeof value === "object") {
    const array = Array.isArray(value);
    const entries = Object.entries(value).map(
      ([key, item]) =>
        `${indent}  ${array ? "" : `${JSON.stringify(key)}: `}${readableRequest(item, depth + 1)}`,
    );
    return `${array ? "[" : "{"}\n${entries.join(",\n")}\n${indent}${array ? "]" : "}"}`;
  }
  return JSON.stringify(value);
}
function reasoningText(records) {
  const turns = [];
  let turn;
  const itemText = (items) =>
    (items ?? [])
      .filter((item) => ["reasoning", "message"].includes(item.type))
      .map((item) => {
        const parts = (list) =>
          (list ?? []).map((part) => part.text ?? "").join("\n\n");
        return parts(item.content) || parts(item.summary);
      })
      .filter(Boolean)
      .join("\n\n");
  for (const event of records) {
    if (!turn || event.type === "request") {
      turn = { chunks: new Map(), items: [], complete: "" };
      turns.push(turn);
    }
    if (event.type === "response") turn.complete = itemText(event.data.output);
    if (event.type !== "provider.event") continue;
    const data = event.data;
    if (data.type === "response.output_item.done") turn.items.push(data.item);
    if (!/reasoning|output_text/.test(data.type ?? "")) continue;
    const kind = (data.type ?? "").replace(/\.(delta|done)$/, "");
    const key = JSON.stringify([
      data.item_id ?? data.output_index,
      kind,
      data.content_index ?? data.summary_index,
    ]);
    // Delta boundaries are transport details, not word or paragraph boundaries.
    if (typeof data.delta === "string")
      turn.chunks.set(key, (turn.chunks.get(key) ?? "") + data.delta);
    else if (typeof data.text === "string" && data.type.endsWith(".done"))
      turn.chunks.set(key, data.text);
  }
  return turns
    .map(
      (part) =>
        part.complete ||
        [...part.chunks.values()].join("\n\n") ||
        itemText(part.items),
    )
    .filter(Boolean)
    .join("\n\n—— Next model response ——\n\n");
}
function renderTrace() {
  const comparison = events.find((e) => e.type === "context.comparison")?.data;
  const prepared = events.find((e) => e.type === "context.prepared")?.data;
  $("context-stats").textContent = prepared
    ? `Parent context: ${prepared.parentMode}${prepared.parentAbsent ? " · No parent supplied" : ` · ${prepared.originalChars.toLocaleString()} → ${prepared.preparedChars.toLocaleString()} characters (source + labels, not tokens)${prepared.effectiveMode !== prepared.parentMode ? ` · Fallback: ${prepared.effectiveMode}` : ""}`}. ${(prepared.warnings ?? []).join(" ")}`
    : "Parent context statistics not recorded for this run (older runs are unchanged).";
  if (comparison)
    $("context-stats").textContent =
      `Context estimate: ${comparison.baseline} → ${comparison.selected} tokens (${comparison.reductionPercent.toFixed(1)}% reduction). Protected CSS: ${comparison.protectedCssTokens} tokens. ${comparison.estimator}`;
  if (comparison?.references)
    $("context-stats").textContent +=
      "\n" +
      comparison.references
        .map(
          (ref) =>
            `${ref.kind}: ${ref.url} · ${ref.selectedLevel ?? "not recorded"}`,
        )
        .join("\n");
  const actualEstimates = events
    .filter((e) => e.type === "context.estimate")
    .map(
      (e) =>
        `Request ${e.data.request}: ${e.data.before === null ? "" : `${e.data.before} → `}${e.data.final} estimated tokens`,
    );
  if (actualEstimates.length)
    $("context-stats").textContent += "\n" + actualEstimates.join("\n");
  const policies = events.filter((e) => e.type === "cache.policy");
  const usage = events
    .filter((e) => e.type === "step.end")
    .map((e, i) => {
      const u = e.data.usage ?? {};
      const details =
        u.inputTokensDetails ??
        u.input_tokens_details ??
        u.promptTokensDetails ??
        u.prompt_tokens_details ??
        {};
      const read = details.cachedTokens ?? details.cached_tokens;
      const write = details.cacheWriteTokens ?? details.cache_write_tokens;
      return `Step ${e.data.step ?? i + 1}: input ${u.inputTokens ?? u.input_tokens ?? "not reported"} · cache read ${read ?? "not reported"} · cache write ${write ?? "not reported"}`;
    });
  $("cache-stats").textContent = [
    policies.length
      ? `Cache: ${policies.at(-1).data.boundary}; hits depend on provider, prefix size and expiry.`
      : "Cache policy not recorded.",
    ...(usage.length ? usage : ["Cache read/write: not reported yet."]),
  ].join("\n");
  $("request-controls").hidden = inspector !== "request";
  if (inspector === "state") return;
  let text = "";
  let note = "";
  if (inspector === "request") {
    const requests = events.filter((e) => e.type === "request");
    const picker = $("requests");
    // Append while streaming so a user's selected request stays selected.
    for (let i = picker.options.length; i < requests.length; i++) {
      const event = requests[i];
      picker.append(option(String(i), `Request ${i + 1} · ${event.at}`));
    }
    picker.disabled = requests.length === 0;
    const selected = requests[Number(picker.value)];
    text = selected
      ? $("readable-strings").checked
        ? readableRequest(selected.data?.body ?? selected.data)
        : JSON.stringify(selected.data?.body ?? selected.data, null, 2)
      : "No outgoing request was recorded for this run yet. Older traces without request records cannot reconstruct the exact payload; check Prompt sources or download the trace.";
    note = selected
      ? `${selected.data?.method ?? ""} ${selected.data?.url ?? ""} · Request ${Number(picker.value) + 1} of ${requests.length}. Captured outgoing JSON with secrets redacted, including history, tools and settings—not the provider's internal prompt formatting.`
      : "Request records are displayed as saved; no prompt is reconstructed.";
    if (selected && $("readable-strings").checked)
      note +=
        " Readable display only—not valid request JSON. [JSON string] expands embedded JSON; | starts literal text with line breaks and tabs. Saved data is unchanged.";
  } else if (inspector === "prompts") {
    const contexts = events.filter((e) => e.type === "context");
    text = contexts
      .map((e) => {
        const data = e.data ?? {};
        if (Array.isArray(data.prompts) && data.prompts.length)
          return data.prompts
            .map(
              (p) =>
                `# ${p.name}\n${p.sha256 ? `SHA-256: ${p.sha256}\n` : ""}\n${p.content}`,
            )
            .join("\n\n");
        return (
          data.instructions ??
          "No prompt source snapshot in this context record."
        );
      })
      .join("\n\n");
    text ||= "No prompt sources were recorded for this run.";
    note =
      "Saved prompt snapshots for this run, shown once—not today's editable files or the complete model input. See Outgoing request for assembled instructions and conversation history.";
  } else if (inspector === "metadata") {
    const capabilities = events.filter((e) => e.type === "capability");
    text = capabilities.length
      ? JSON.stringify(
          capabilities.map((e) => e.data),
          null,
          2,
        )
      : "No model metadata was recorded for this run.";
    note =
      "Catalog metadata used for capability checks. This record is not sent wholesale to the model; actual request settings appear in Outgoing request.";
  } else if (inspector === "usage")
    text =
      JSON.stringify(
        events.filter(
          (e) =>
            e.type === "step.end" ||
            (e.type === "asset.result" && e.data?.result?.usage),
        ),
        null,
        2,
      ) || "No usage reported.";
  else if (inspector === "reasoning") {
    text = reasoningText(events);
    note =
      "Streamed chunks are joined without added whitespace; model-provided paragraphs are preserved. Completion snapshots are not repeated. Raw events remain in Timeline and Download trace.";
    if (!text)
      text =
        "No provider-visible reasoning/text events yet. Some models return only summaries, opaque reasoning items, or no reasoning text. Check the full trace for those items.";
  } else {
    const visible = events.slice(-300);
    text = visible
      .map(
        (e) =>
          `${e.seq} · ${e.at} · ${e.type}\n${JSON.stringify(e.data, null, 2)}`,
      )
      .join("\n\n");
    note =
      events.length > 300
        ? `Showing the latest 300 of ${events.length} events. Download trace contains every persisted event; this display limit does not affect model context.`
        : `${events.length} events · Full trace is saved on disk.`;
  }
  const nearBottom =
    $("trace").scrollHeight - $("trace").scrollTop - $("trace").clientHeight <
    80;
  $("trace").textContent = text || "No events yet.";
  $("trace-note").textContent = note;
  if (nearBottom) $("trace").scrollTop = $("trace").scrollHeight;
}
$("create-form").onsubmit = guarded(async (event) => {
  event.preventDefault();
  notice("");
  $("generate").disabled = true;
  try {
    const data = await api("/sessions", "POST", taskRequest());
    await selectSession(data.session.id);
  } finally {
    $("generate").disabled = false;
  }
});
$("new-session").onclick = guarded(async () => {
  populationUI.reset();
  const displayed =
    session && version
      ? { sessionId: session.id, versionId: version.id }
      : null;
  const ancestor = displayed
    ? await api("/ancestor", "POST", displayed)
    : { reference: null, warnings: [] };
  stream?.close();
  session = null;
  version = null;
  activeRun = null;
  history.replaceState(null, "", location.pathname);
  $("experiment").hidden = true;
  $("empty").hidden = false;
  $("create-form").elements.path.focus();
  await refresh();
  $("internal-reference").value = ancestor.reference
    ? `${ancestor.reference.sessionId}/${ancestor.reference.versionId}`
    : "";
  invalidatePreparation();
  if (ancestor.warnings.length) notice(ancestor.warnings.join(" "));
});
function taskRequest() {
  if ($("population-enabled").checked && populationUI.stale)
    throw new Error(
      "Population result is stale. Populate again or disable population to continue manually.",
    );
  const form = Object.fromEntries(new FormData($("create-form")));
  const [sessionId, versionId] = $("internal-reference").value.split("/");
  return {
    ...form,
    ...($("population-enabled").checked
      ? {
          populatedBrief: $("populated-brief").value,
          ...(populationUI.acceptedId
            ? { populationId: populationUI.acceptedId }
            : {}),
        }
      : {}),
    internalReference: sessionId ? { sessionId, versionId } : null,
    internalCompression: $("internal-compression").value,
    externalReferences: [...$("external-references").children]
      .map((row) => ({
        url: row.querySelector("input").value,
        compression: row.querySelector("select").value,
      }))
      .filter((r) => r.url.trim()),
    ...(preparationId ? { preparationId } : {}),
  };
}
function invalidatePreparation() {
  preparationId = undefined;
  $("preparation-summary").hidden = true;
}
$("create-form").addEventListener("input", (e) => {
  if (e.target.tagName !== "SELECT") invalidatePreparation();
});
$("internal-reference").onchange = invalidatePreparation;
$("session-filter").onchange = guarded(refresh);
fillLevels($("internal-compression"));
$("add-reference").onclick = () => {
  const row = document.createElement("div"),
    label = document.createElement("label"),
    input = document.createElement("input"),
    select = document.createElement("select"),
    remove = document.createElement("button");
  label.textContent = "External reference URL";
  input.type = "url";
  input.placeholder = "https://example.com";
  label.append(input);
  select.setAttribute("aria-label", "External compression");
  fillLevels(select);
  remove.type = "button";
  remove.textContent = "Remove";
  remove.onclick = () => {
    row.remove();
    invalidatePreparation();
  };
  row.append(label, select, remove);
  $("external-references").append(row);
  invalidatePreparation();
};
async function compareContext(refresh = false) {
  if (!$("create-form").reportValidity()) return;
  if (refresh) preparationId = undefined;
  const request = taskRequest();
  const data = await api("/prepare", "POST", request);
  if (JSON.stringify(request) !== JSON.stringify(taskRequest())) return;
  preparationId = data.preparationId;
  const c = data.comparison;
  $("preparation-summary").hidden = false;
  $("preparation-summary").textContent =
    `${c.estimator}\nWhole request: ${c.baseline} → ${c.selected} estimated tokens (${c.reductionPercent.toFixed(1)}% reduction)\nProtected base CSS: ${c.protectedCssTokens} tokens\n` +
    c.references
      .map(
        (ref) =>
          `\n${ref.kind}: ${ref.url}\nOriginal: ${ref.originalTokens} tokens\n` +
          ref.levels
            .map(
              (l) =>
                `${l.level}: HTML ${l.tokens.html}, CSS ${l.tokens.css}, total ${l.tokens.total}; whole request ${l.wholeRequestEstimate}\n${[...l.omissions, ...l.warnings].join("\n")}`,
            )
            .join("\n\n"),
      )
      .join("\n");
}
$("prepare-context").onclick = guarded(() => compareContext());
$("refresh-context").onclick = guarded(() => compareContext(true));
$("archive-session").onclick = guarded(async () => {
  if (!session || !version) return;
  if (
    !confirm(
      `Archive selected v${session.versions.indexOf(version.id) + 1} of ${session.path} and release this URL? All history is preserved; the session becomes read-only.`,
    )
  )
    return;
  await api(`/sessions/${session.id}/archive`, "POST", {
    versionId: version.id,
  });
  $("session-filter").value = "archived";
  await selectSession(session.id);
});
$("chat-form").onsubmit = guarded(async (event) => {
  event.preventDefault();
  notice("");
  const message = $("message").value;
  $("send").disabled = true;
  try {
    const run = await api(`/sessions/${session.id}/turns`, "POST", { message });
    $("message").value = "";
    setBusy(run.id);
    await selectSession(session.id);
  } catch (error) {
    setBusy(null);
    throw error;
  }
});
$("cancel-run").onclick = guarded(async () => {
  if (activeRun) await api(`/runs/${activeRun}/cancel`, "POST", {});
});
$("versions").onchange = guarded(() => selectVersion($("versions").value));
$("runs").onchange = guarded(() => selectRun($("runs").value));
$("requests").onchange = () => {
  renderTrace();
  $("trace").scrollTop = 0;
};
$("readable-strings").onchange = () => {
  renderTrace();
  $("trace").scrollTop = 0;
};
$("model").onchange = updateEfforts;
document.querySelectorAll("[data-view]").forEach(
  (button) =>
    (button.onclick = () => {
      view = button.dataset.view;
      document
        .querySelectorAll("[data-view]")
        .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      drawVersion();
    }),
);
document.querySelectorAll("[data-inspector]").forEach(
  (button) =>
    (button.onclick = guarded(async () => {
      inspector = button.dataset.inspector;
      $("request-controls").hidden = inspector !== "request";
      document
        .querySelectorAll("[data-inspector]")
        .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      if (inspector === "state") {
        $("trace").textContent = JSON.stringify(
          await api(`/sessions/${session.id}/state`),
          null,
          2,
        );
        $("trace-note").textContent =
          "Opaque SDK state, including preserved conversation/reasoning items. No history compaction.";
      } else renderTrace();
    })),
);
$("download-trace").onclick = guarded(async () => {
  const data = await api(`/runs/${$("runs").value}`);
  const url = URL.createObjectURL(
    new Blob([data.events.map((e) => JSON.stringify(e)).join("\n") + "\n"], {
      type: "application/x-ndjson",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `${data.run.id}.jsonl`;
  a.click();
  URL.revokeObjectURL(url);
});
function drawPrompt() {
  const prompt = prompts.find((p) => p.name === $("prompt-file").value);
  $("prompt-content").value = prompt?.content ?? "";
  $("prompt-status").textContent = "";
}
$("prompt-toggle").onclick = guarded(async () => {
  prompts = await api("/prompts");
  $("prompt-file").replaceChildren(
    ...prompts.map((p) => option(p.name, p.name)),
  );
  drawPrompt();
  $("prompts-dialog").showModal();
});
$("close-prompts").onclick = () => $("prompts-dialog").close();
$("prompt-file").onchange = drawPrompt;
$("save-prompt").onclick = guarded(async () => {
  const prompt = prompts.find((p) => p.name === $("prompt-file").value);
  await api(`/prompts/${prompt.name}`, "PUT", {
    content: $("prompt-content").value,
    sha256: prompt.sha256,
  });
  prompts = await api("/prompts");
  $("prompt-status").textContent = "Saved. Future runs will use this source.";
});
await guarded(async () => {
  await refresh();
  $("model").append(
    ...bootstrap.models.map((m) =>
      option(String(m.number), `${m.number}. ${m.label}`),
    ),
  );
  try {
    catalog = await api("/models");
    updateEfforts();
  } catch (error) {
    notice(
      `Model catalog unavailable: ${error.message}. Each run will recheck capabilities before inference.`,
    );
  }
  if (location.hash) await selectSession(location.hash.slice(1));
  if (new URLSearchParams(location.search).get("prompts") === "1")
    $("prompt-toggle").click();
})();
const populationUI = initializePopulation(
  api,
  guarded,
  invalidatePreparation,
  () => bootstrap,
  () => catalog,
);

// Static previews remain script-disabled by their response CSP. Interactive
// previews permit only the trusted region bridge; generated code is isolated
// inside opaque child frames. The parent also follows loading shells.
let previewNavigation = 0;
let previewClock;
$("preview").addEventListener("load", () => {
  clearInterval(previewClock);
  const navigation = ++previewNavigation;
  const frame = $("preview");
  try {
    const url = new URL(frame.contentWindow.location.href);
    const doc = frame.contentDocument;
    const id = doc?.body?.dataset.attempt;
    if (
      url.origin !== location.origin ||
      !id ||
      !doc.body.classList.contains("loading")
    )
      return;
    $("open-page").href = url.href;
    tick(doc);
    previewClock = setInterval(() => tick(doc), 1000);
    const open = doc.querySelector('a[target="_blank"]');
    if (open)
      open.onclick = (event) => {
        event.preventDefault();
        window.open(url.href, "_blank", "noopener");
      };
    const poll = async () => {
      if (navigation !== previewNavigation) return;
      try {
        const record = await api(`/automatic/${encodeURIComponent(id)}/status`);
        if (navigation !== previewNavigation) return;
        updateProgress(doc, record);
        if (record.status !== "running") {
          clearInterval(previewClock);
          frame.src = url.href;
          return;
        }
        setTimeout(poll, 1000);
      } catch {
        /* The shell's Open page link remains available. */
      }
    };
    if (doc.body.dataset.status === "running") void poll();
  } catch {
    /* Cross-origin frames are not inspected. */
  }
});
