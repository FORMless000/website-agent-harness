const $ = (id) => document.getElementById(id);
let bootstrap,
  session,
  version,
  stream,
  activeRun,
  events = [],
  prompts = [],
  catalog = [],
  view = "preview",
  inspector = "timeline",
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
async function refresh() {
  bootstrap = await api("/bootstrap");
  $("settings").textContent =
    `LOCALHOST ONLY  ·  Assets: ${bootstrap.config.assets}  ·  Max ${bootstrap.config.maxSteps} agent steps/run`;
  if (!bootstrap.config.keyConfigured)
    notice(
      "No API key configured. Set OPENROUTER_API_KEY in the ignored .env file and restart the server. Do not paste credentials into prompts.",
    );
  $("sessions").replaceChildren(
    ...bootstrap.sessions.map((s) => {
      const button = document.createElement("button");
      button.className = `session ${session?.id === s.id ? "active" : ""}`;
      const title = document.createElement("strong");
      title.textContent = s.path;
      const detail = document.createElement("small");
      detail.textContent = `${bootstrap.models.find((m) => m.id === s.model)?.label ?? s.model} · ${s.versions.length} versions`;
      button.append(title, detail);
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
  $("send").disabled = !!runId;
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
  $("open-page").href = session.path;
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
function renderTrace() {
  if (inspector === "state") return;
  let text = "";
  let note = "";
  if (inspector === "context")
    text = JSON.stringify(
      events.filter((e) =>
        ["context", "capability", "request"].includes(e.type),
      ),
      null,
      2,
    );
  else if (inspector === "usage")
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
    text = events
      .filter(
        (e) =>
          e.type === "provider.event" &&
          (/reasoning|output_text/.test(e.data.type ?? "") ||
            (e.data.type === "response.output_item.done" &&
              ["reasoning", "message"].includes(e.data.item?.type))),
      )
      .map((e) =>
        typeof e.data.delta === "string"
          ? e.data.delta
          : JSON.stringify(e.data),
      )
      .join("\n");
    if (!text)
      text = events
        .filter((e) => e.type === "response")
        .flatMap((e) => e.data.output ?? [])
        .filter((item) => ["reasoning", "message"].includes(item.type))
        .map((item) => JSON.stringify(item, null, 2))
        .join("\n");
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
    const data = await api(
      "/sessions",
      "POST",
      Object.fromEntries(new FormData(event.target)),
    );
    await selectSession(data.session.id);
  } finally {
    $("generate").disabled = false;
  }
});
$("new-session").onclick = () => {
  stream?.close();
  session = null;
  version = null;
  activeRun = null;
  history.replaceState(null, "", location.pathname);
  $("experiment").hidden = true;
  $("empty").hidden = false;
  $("create-form").elements.path.focus();
  void refresh();
};
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
})();
