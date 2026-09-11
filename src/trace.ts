import type { Emit } from "./assets.js";

// Read a clone of the SDK HTTP response. Capturing the actual SSE wire stream
// avoids the SDK 0.11.0 broadcaster's late error-handler race with slow readers.
// SDK request consumption and trace persistence run concurrently; both must
// finish before the harness advances to the tool boundary.
export async function recordResponse(response: Response, emit: Emit) {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* Non-JSON provider error is still evidence. */
    }
    await emit("provider.http", { status: response.status, body });
    return;
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  async function frame(text: string) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      await emit("provider.done", {});
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      event = { raw: data };
    }
    await emit("provider.event", event);
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      pending = pending.replace(/\r\n/g, "\n");
      let end: number;
      while ((end = pending.indexOf("\n\n")) >= 0) {
        await frame(pending.slice(0, end));
        pending = pending.slice(end + 2);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) await frame(pending);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
