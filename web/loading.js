import { updateProgress, tick } from "/_settings/progress.js";
const message = document.getElementById("message");
const retry = document.getElementById("retry");
let id = document.body.dataset.attempt;
let timer;
const clock = setInterval(() => tick(document), 1000);
tick(document);
async function poll() {
  try {
    const response = await fetch(`/api/automatic/${id}/status`);
    if (!response.ok) throw new Error("Unavailable");
    const result = await response.json();
    updateProgress(document, result);
    if (result.status === "success") {
      location.reload();
      return;
    }
    if (result.status === "failed") {
      fail();
      return;
    }
    timer = setTimeout(poll, 1000);
  } catch {
    fail();
  }
}
function fail() {
  clearTimeout(timer);
  document.body.dataset.finishedAt ||= new Date().toISOString();
  tick(document);
  document.getElementById("phase").textContent = "";
  message.textContent = "Unable to load this page";
  document.title = "Unable to load this page";
  retry.hidden = !id;
  retry.disabled = false;
}
retry.onclick = async () => {
  retry.disabled = true;
  try {
    const response = await fetch(`/api/automatic/${id}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Harness-Request": "1" },
      body: "{}",
    });
    if (!response.ok) throw new Error("Unavailable");
    const result = await response.json();
    id = result.id;
    document.body.dataset.startedAt = "";
    document.body.dataset.finishedAt = "";
    document.getElementById("progress").hidden = false;
    document.getElementById("phase").textContent = "Preparing page…";
    retry.hidden = true;
    message.textContent = "Loading…";
    document.title = "Loading";
    await poll();
  } catch {
    fail();
  }
};
if (id && document.body.dataset.status === "running") void poll();
addEventListener("pagehide", () => {
  clearTimeout(timer);
  clearInterval(clock);
});
