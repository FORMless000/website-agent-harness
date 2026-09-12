import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import http from "node:http";
import { Harness } from "../src/harness.js";
import { createHttpServer } from "../src/server.js";
import { createDriver } from "../src/agent.js";
import { ROOT } from "../src/config.js";
import {
  artifact,
  catalog,
  testConfig,
  mockTransport,
  submission,
} from "./fixtures.js";

test("HTTP publishing, version preview, security, SSE replay and CLI clients", async () => {
  const config = await testConfig();
  config.port = 0;
  const harness = new Harness(
    config,
    createDriver(
      mockTransport([
        [submission(artifact())],
        [submission(artifact("Edited museum"), "edit")],
        [submission(artifact("CLI child"), "cli-child")],
      ]),
    ),
    async () => catalog,
  );
  const server = createHttpServer(harness);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No server address");
  config.port = address.port;
  const origin = `http://127.0.0.1:${config.port}`;
  const headers = {
    "Content-Type": "application/json",
    "X-Harness-Request": "1",
  };
  try {
    assert.equal((await fetch(origin + "/_harness/")).status, 200);
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      http
        .get(
          origin + "/api/bootstrap",
          { headers: { Host: "evil.example" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        )
        .on("error", reject);
    });
    assert.equal(badHost, 403);
    assert.equal(
      (
        await fetch(origin + "/api/sessions", {
          method: "POST",
          body: "{}",
          headers: { "Content-Type": "application/json" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(origin + "/api/sessions", {
          method: "POST",
          body: "{}",
          headers: { ...headers, Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    const result = await fetch(origin + "/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ path: "/deep/arbitrary/path", model: 1 }),
    });
    assert.equal(result.status, 201);
    const created = (await result.json()) as {
      session: { id: string };
      run: { id: string };
    };
    const run = await harness.wait(created.run.id);
    assert.equal(run.status, "success", run.error);
    const page = await fetch(origin + "/deep/arbitrary/path");
    assert.equal(page.status, 200);
    assert.match(
      page.headers.get("content-security-policy")!,
      /script-src 'none'/,
    );
    assert.match(await page.text(), /A tiny museum/);
    assert.equal(
      (await fetch(origin + "/not-created", { method: "HEAD" })).status,
      404,
    );
    const preview = await fetch(
      origin + `/api/preview/${created.session.id}/${run.versionId}`,
    );
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get("content-security-policy")!, /sandbox/);
    const events = await (
      await fetch(origin + `/api/runs/${run.id}/events`)
    ).text();
    assert.match(events, /run.end/);
    assert.match(events, /published/);
    const records = await harness.store.events(run.id);
    const after = records.at(-2)!.seq;
    const replay = await (
      await fetch(origin + `/api/runs/${run.id}/events?after=${after}`)
    ).text();
    assert.equal(replay.split("data: ").length - 1, 1);
    const exec = promisify(execFile);
    const list = await exec(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(ROOT, "src/cli.ts"),
        "sessions",
        "--port",
        String(config.port),
      ],
      { cwd: ROOT },
    );
    assert.match(list.stdout, /deep\/arbitrary\/path/);
    const edit = await exec(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(ROOT, "src/cli.ts"),
        "edit",
        created.session.id,
        "--message",
        "Edit the title",
        "--port",
        String(config.port),
        "--json",
      ],
      { cwd: ROOT },
    );
    assert.match(edit.stdout, /run.end/);
    assert.match(
      await (await fetch(origin + "/deep/arbitrary/path")).text(),
      /Edited museum/,
    );
    const boot = await (await fetch(origin + "/api/bootstrap")).text();
    assert.doesNotMatch(boot, /offline-test-key/);
    const child = await exec(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(ROOT, "src/cli.ts"),
        "create",
        "--path",
        "/cli-child",
        "--model",
        "1",
        "--parent",
        origin + "/deep/arbitrary/path",
        "--parent-context",
        "compact",
        "--port",
        String(config.port),
      ],
      { cwd: ROOT },
    );
    assert.match(child.stdout, /success/);
    assert.equal(
      (await harness.store.byPath("/cli-child"))?.parentContextMode,
      "compact",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
