// Only this trusted document performs network requests. Each child has an opaque
// origin, so both source window and visit/region identity must match.
const bootstrap = document.getElementById("harness-regions");
if (bootstrap) {
  const config = JSON.parse(bootstrap.textContent);
  const entries = new Map();
  for (const region of config.regions) {
    const placeholder = [...document.querySelectorAll("[data-region-id]")].find(
      (node) => node.dataset.regionId === region.id,
    );
    if (!placeholder) continue;
    const frame = document.createElement("iframe");
    frame.className = `${placeholder.className} harness-region-frame`;
    frame.id = placeholder.id;
    frame.style.cssText = `width:100%;border:0;display:block;${placeholder.getAttribute("style") || ""}`;
    frame.title = region.purpose || region.id;
    frame.dataset.regionId = region.id;
    frame.setAttribute("sandbox", "allow-scripts");
    frame.src = `/api/region-frame/${config.visitId}/${region.id}`;
    entries.set(region.id, { frame, revision: 0, active: false });
    placeholder.replaceWith(frame);
  }
  const send = (entry, id, data) =>
    entry.frame.contentWindow.postMessage(
      { visitId: config.visitId, id, ...data },
      "*",
    );
  const request = async (url, body) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Harness-Request": "1" },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
    return value;
  };
  window.addEventListener("message", async (message) => {
    const data = message.data;
    const entry = data && entries.get(data.id);
    if (
      !entry ||
      message.origin !== "null" ||
      message.source !== entry.frame.contentWindow ||
      data.visitId !== config.visitId
    )
      return;
    const url = `/api/interactions/${config.visitId}/${data.id}`;
    if (data.type === "region:event") {
      if (entry.active || data.revision !== entry.revision) return;
      entry.active = true;
      try {
        const value = await request(url, {
          revision: entry.revision,
          event: data.event,
        });
        if (value.revision !== entry.revision + 1)
          throw new Error("Unexpected region revision.");
        entry.revision = value.revision;
        send(entry, data.id, { ...value, type: "region:update" });
      } catch (error) {
        send(entry, data.id, {
          type: "region:error",
          operation: "interaction",
          message: error.message,
        });
      } finally {
        entry.active = false;
      }
    } else if (data.type === "region:navigate") {
      try {
        const value = await request(`${url}/navigate`, { path: data.path });
        if (value.url) location.assign(value.url);
      } catch (error) {
        send(entry, data.id, {
          type: "region:error",
          operation: "navigation",
          message: error.message,
        });
      }
    } else if (data.type === "region:resize" && Number.isFinite(data.height)) {
      entry.frame.style.height = `${Math.max(1, Math.ceil(data.height))}px`;
    }
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) location.reload();
  });
}
