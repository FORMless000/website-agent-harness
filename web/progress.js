const phases = {
  preparing: "Preparing page…",
  description: "Generating description…",
  reasoning: "Reasoning…",
  response: "Generating final response…",
};
export function tick(doc) {
  const started = Date.parse(doc.body.dataset.startedAt);
  const end = doc.body.dataset.finishedAt
    ? Date.parse(doc.body.dataset.finishedAt)
    : Date.now();
  const seconds = Math.max(0, Math.floor((end - started) / 1000));
  const label = !Number.isFinite(seconds)
    ? "0s"
    : seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  doc.getElementById("elapsed").textContent = `Elapsed: ${label}`;
}
export function updateProgress(doc, progress) {
  doc.body.dataset.startedAt = progress.startedAt ?? "";
  doc.body.dataset.finishedAt = progress.finishedAt ?? "";
  doc.getElementById("phase").textContent =
    progress.status === "running"
      ? (phases[progress.phase] ?? phases.preparing)
      : "";
  tick(doc);
}
