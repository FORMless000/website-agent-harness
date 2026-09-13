import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Harness } from "../src/harness.js";
import { createHttpServer } from "../src/server.js";
import { Interactions } from "../src/interactions.js";
import { AutomaticPages } from "../src/automatic.js";
import { Settings } from "../src/settings.js";
import { artifact, catalog, testConfig } from "./fixtures.js";

test("region HTTP bridge isolates scripts, resets visits and feeds destination intent into lazy generation", async () => {
  const config = await testConfig();
  const descriptions: string[] = [];
  const harness = new Harness(
    config,
    async ({ input }) => {
      const source = typeof input === "string" ? input : JSON.stringify(input);
      descriptions.push(source);
      const page = artifact("Region HTTP fixture");
      page.html = page.html.replace(
        "</main>",
        '<div data-region-id="visit"></div></main>',
      );
      page.regions = [
        {
          id: "visit",
          purpose: "Pick a destination",
          html: '<button data-region-action="next">Next</button>',
          css: null,
          state: {},
          javascript: "region.setState({started:true});",
        },
      ];
      return {
        artifact: page,
        text: "fixture",
        staged: [],
        pageDescription: "Region fixture",
      };
    },
    async () => catalog,
  );
  const created = await harness.create({ path: "/http-regions", model: 1 });
  await harness.wait(created.run.id);
  const settings = new Settings(config);
  const saved = await settings.get();
  await settings.save({
    revision: saved.revision,
    settings: { ...saved.settings, descriptionEnabled: false, assets: "none" },
  });
  let calls = 0;
  const interactions = new Interactions(harness, async () => {
    calls++;
    return {
      html: '<a href="/http-regions/result">Open result</a>',
      css: null,
      state: { done: true },
      destinations: [
        {
          path: "/http-regions/result",
          description: "An invented catalog of tiny moons",
        },
      ],
    };
  });
  const automatic = new AutomaticPages(harness);
  const server = createHttpServer(harness, automatic, interactions);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  config.port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${config.port}`;
  const fetchPage = async () => {
    const response = await fetch(`${base}/http-regions`);
    const html = await response.text();
    const data = JSON.parse(
      /<script id="harness-regions"[^>]*>([^<]+)<\/script>/.exec(html)![1],
    );
    return { response, html, data };
  };
  try {
    const first = await fetchPage(),
      second = await fetchPage();
    assert.notEqual(first.data.visitId, second.data.visitId);
    assert.equal(calls, 0);
    assert.match(
      first.response.headers.get("content-security-policy")!,
      /script-src 'nonce-/,
    );
    assert.doesNotMatch(first.html, /setState/);
    const frame = await fetch(
      `${base}/api/region-frame/${first.data.visitId}/visit`,
    );
    assert.match(
      frame.headers.get("content-security-policy")!,
      /sandbox allow-scripts/,
    );
    assert.doesNotMatch(
      frame.headers.get("content-security-policy")!,
      /allow-same-origin/,
    );
    assert.match(await frame.text(), /region-script/);
    const route = `${base}/api/interactions/${first.data.visitId}/visit`;
    const event = {
      revision: 0,
      event: { action: "next", inputs: {}, state: {} },
    };
    assert.equal(
      (await fetch(route, { method: "POST", body: JSON.stringify(event) }))
        .status,
      403,
    );
    const post = (url: string, body: unknown) =>
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Harness-Request": "1",
          Origin: base,
        },
        body: JSON.stringify(body),
      });
    assert.equal((await post(route, event)).status, 200);
    assert.equal((await post(route, event)).status, 409);
    assert.equal(calls, 1);
    assert.equal(
      descriptions.length,
      1,
      "declaring a destination must not generate it",
    );
    assert.equal(
      (await post(`${route}/navigate`, { path: "/api/settings" })).status,
      400,
    );
    const navigation = await post(`${route}/navigate`, {
      path: "/http-regions/result",
    });
    assert.deepEqual(await navigation.json(), { url: "/http-regions/result" });
    await automatic.close();
    // The attempt preserves intent even if shutdown interrupts generation.
    const attempts = await automatic.list();
    assert.equal(
      attempts[0]?.destinationDescription,
      "An invented catalog of tiny moons",
    );
    const current = await interactions.get(second.data.visitId, "visit");
    assert.equal(current.current.revision, 0);
    assert.ok(
      await readFile(
        harness.store.file("visits", first.data.visitId, "region-visit.json"),
        "utf8",
      ),
    );
  } finally {
    await automatic.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
