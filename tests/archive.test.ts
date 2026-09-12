import { test } from "node:test";
import assert from "node:assert/strict";
import { Harness } from "../src/harness.js";
import { createHttpServer, serve } from "../src/server.js";
import { artifact, catalog, testConfig } from "./fixtures.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { ROOT } from "../src/config.js";
test("archive route serves selected version, rebases links, survives restart, and CLI prepares references", async () => {
  const config = await testConfig();
  let count = 0;
  const harness = new Harness(
    config,
    async () => ({
      pageDescription: "A small museum fixture with a next-page link.",
      artifact: {
        ...artifact(`Version ${++count}`),
        html: artifact(`Version ${count}`).html.replace(
          "</body>",
          '<a href="/root/next">Next</a></body>',
        ),
      },
      staged: [],
      text: "fixture",
    }),
    async () => catalog,
  );
  const server = createHttpServer(harness);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  config.port = address.port;
  const origin = `http://127.0.0.1:${config.port}`,
    headers = { "Content-Type": "application/json", "X-Harness-Request": "1" };
  try {
    const first = await harness.create({ path: "/root/page", model: 1 });
    const v1 = (await harness.wait(first.run.id)).versionId!;
    const edit = await harness.start(first.session.id, "Edit");
    await harness.wait(edit.id);
    const response = await fetch(
      `${origin}/api/sessions/${first.session.id}/archive`,
      { method: "POST", headers, body: JSON.stringify({ versionId: v1 }) },
    );
    assert.equal(response.status, 200, await response.clone().text());
    const archived = (await response.json()) as { archived: { url: string } };
    const html = await (await fetch(origin + archived.archived.url)).text();
    assert.match(html, /Version 1/);
    assert.doesNotMatch(html, /Version 2/);
    assert.match(html, /href="\/root\/next"/);
    assert.equal((await fetch(origin + "/root/page")).status, 404);
    const replacement = await harness.create({ path: "/root/page", model: 1 });
    const vr = (await harness.wait(replacement.run.id)).versionId!;
    const second = await harness.archive(replacement.session.id, vr);
    assert.notEqual(second.archived!.url, archived.archived.url);
    assert.match(
      await (await fetch(origin + archived.archived.url)).text(),
      /Version 1/,
    );
    const reopened = new Harness(config, undefined, async () => catalog);
    assert.equal(
      (await reopened.store.session(first.session.id)).archived?.versionId,
      v1,
    );
    assert.equal(
      (await reopened.store.session(first.session.id)).runs.length,
      2,
    );
    const cli = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(ROOT, "src/cli.ts"),
        "prepare",
        "--path",
        "/root/new",
        "--model",
        "1",
        "--internal",
        `${first.session.id}/${v1}`,
        "--internal-level",
        "brief",
        "--port",
        String(config.port),
      ],
      { cwd: ROOT },
    );
    const prepared = JSON.parse(cli.stdout);
    assert.ok(prepared.preparationId);
    assert.ok(prepared.comparison.protectedCssTokens > 0);
    assert.equal(
      (await fetch(origin + `/_archive/${first.session.id}/wrong/root/page`))
        .status,
      404,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("archive namespace collisions fail startup without hiding the existing page", async () => {
  const config = await testConfig();
  const harness = new Harness(
    config,
    async () => ({ artifact: artifact(), staged: [], text: "fixture" }),
    async () => catalog,
  );
  const made = await harness.create({ path: "/old", model: 1 });
  await harness.wait(made.run.id);
  const s = await harness.store.session(made.session.id);
  s.path = "/_archive/existing";
  await harness.store.saveSession(s);
  await assert.rejects(() => serve(harness), /namespace conflicts/);
});
