import { Store, atomicWrite } from "./store.js";

// Sidecars add metadata without rewriting historical immutable artifacts.
export async function indexDescriptions(store: Store) {
  const entries = [];
  for (const session of await store.sessions()) {
    for (const versionId of session.versions) {
      const file = store.file("descriptions", `${session.id}_${versionId}`);
      let pageDescription: string;
      try {
        pageDescription = (await store.json<{ pageDescription: string }>(file))
          .pageDescription;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        pageDescription =
          (await store.version(session.id, versionId)).pageDescription ?? "";
        await atomicWrite(
          file,
          JSON.stringify({ sessionId: session.id, versionId, pageDescription }),
        );
      }
      entries.push({ sessionId: session.id, versionId, pageDescription });
    }
  }
  return entries;
}
