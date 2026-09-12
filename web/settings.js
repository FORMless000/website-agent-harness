const form = document.getElementById("settings-form");
const notice = document.getElementById("notice");
let saved,
  revision,
  catalog = [];
const field = (name) => form.elements.namedItem(name);
async function api(route, method = "GET", value) {
  const response = await fetch(`/api/${route}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Harness-Request": "1" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}
function options(select, entries) {
  select.replaceChildren(
    ...entries.map(([value, label]) => new Option(label, value)),
  );
}
function efforts(prefix, preferred) {
  const supported = catalog.find((m) => m.id === field(`${prefix}Model`).value)
    ?.reasoning?.supported_efforts ?? ["low", "medium", "high", "xhigh", "max"];
  const choices = supported.filter((e) =>
    ["low", "medium", "high", "xhigh", "max"].includes(e),
  );
  options(
    field(`${prefix}Effort`),
    choices.map((e) => [e, e]),
  );
  // Keep a saved unsupported value visible so it is never silently substituted.
  if (preferred && !choices.includes(preferred))
    field(`${prefix}Effort`).add(
      new Option(`${preferred} (unavailable)`, preferred),
    );
  field(`${prefix}Effort`).value =
    preferred ?? (choices.includes("high") ? "high" : (choices[0] ?? ""));
}
function dependencies() {
  document.getElementById("description-controls").disabled =
    !field("descriptionEnabled").checked;
  document.getElementById("search-controls").disabled =
    !field("descriptionEnabled").checked;
}
async function load() {
  const data = await api("settings");
  saved = data.settings;
  revision = data.revision;
  try {
    catalog = await api("models");
  } catch {
    notice.textContent =
      "Model catalog unavailable; saved choices remain visible and will be checked on save.";
  }
  for (const prefix of ["website", "description"])
    options(
      field(`${prefix}Model`),
      data.models.map((m) => [m.id, m.label]),
    );
  for (const name of ["internalCompression", "externalCompression"])
    options(field(name), [
      ["clean", "Clean"],
      ["structure", "Structure"],
      ["relevant", "Relevant"],
      ["brief", "Brief"],
    ]);
  for (const [key, value] of Object.entries(saved)) {
    if (key.endsWith("Effort")) continue;
    if (typeof value === "boolean") field(key).checked = value;
    else field(key).value = value;
  }
  for (const prefix of ["website", "description"])
    efforts(prefix, saved[`${prefix}Effort`]);
  dependencies();
  document.getElementById("knowledge-location").textContent =
    data.worldKnowledge.location;
  document.getElementById("knowledge").textContent =
    data.worldKnowledge.content;
  document.getElementById("server").textContent = JSON.stringify(
    data.startup,
    null,
    2,
  );
}
form.onsubmit = async (event) => {
  event.preventDefault();
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const settings = Object.fromEntries(
      Object.entries(saved).map(([key, value]) => [
        key,
        typeof value === "boolean"
          ? field(key).checked
          : typeof value === "number"
            ? Number(field(key).value)
            : field(key).value,
      ]),
    );
    const result = await api("settings", "PUT", { settings, revision });
    saved = result.settings;
    revision = result.revision;
    notice.textContent =
      "Saved. New automatic attempts will use these settings.";
  } catch (error) {
    notice.textContent = String(error);
  } finally {
    button.disabled = false;
  }
};
for (const prefix of ["website", "description"])
  field(`${prefix}Model`).onchange = () =>
    efforts(prefix, field(`${prefix}Effort`).value);
field("descriptionEnabled").onchange = dependencies;
document.getElementById("reload").onclick = () => {
  void load().catch((error) => {
    notice.textContent = String(error);
  });
};
async function attempts() {
  try {
    const records = await api("automatic");
    document.getElementById("attempts").replaceChildren(
      ...records.map((r) => {
        const row = document.createElement("tr");
        for (const value of [
          r.path,
          r.status,
          new Date(r.startedAt).toLocaleString(),
        ]) {
          const cell = document.createElement("td");
          cell.textContent = value;
          row.append(cell);
        }
        const links = document.createElement("td");
        const entries = [["Attempt", `/api/automatic/${r.id}`]];
        if (r.sessionId)
          entries.push([
            "Session",
            `/_harness/#${encodeURIComponent(r.sessionId)}`,
          ]);
        if (r.runId) entries.push(["Run trace", `/api/runs/${r.runId}`]);
        if (r.populationId)
          entries.push([
            "Population trace",
            `/api/populations/${r.populationId}/trace`,
          ]);
        for (const [label, href] of entries) {
          const a = document.createElement("a");
          a.textContent = label;
          a.href = href;
          links.append(a);
        }
        row.append(links);
        return row;
      }),
    );
    document.getElementById("attempts-notice").textContent = records.length
      ? ""
      : "No automatic attempts yet.";
  } catch (error) {
    document.getElementById("attempts-notice").textContent = String(error);
  }
}
document.getElementById("refresh-attempts").onclick = attempts;
await load().catch((error) => {
  notice.textContent = String(error);
  form.querySelector('[type="submit"]').disabled = true;
});
await attempts();
