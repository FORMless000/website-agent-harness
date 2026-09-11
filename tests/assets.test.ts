import { test } from "node:test";
import assert from "node:assert/strict";
import { AssetTools } from "../src/assets.js";
import { renderArtifact, validateArtifact } from "../src/validation.js";
import { artifact, testConfig } from "./fixtures.js";
import type { Asset } from "../src/contracts.js";

const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6lAoAAAAASUVORK5CYII=",
  "base64",
);
test("Openverse search/import and image generation use local artifacts and bounded attempts (mocked network)", async () => {
  const config = await testConfig();
  config.assets = "both";
  config.maxAssets = 2;
  const requests: string[] = [];
  const events: unknown[] = [];
  const id = "53b90494-60f7-4f2e-96f6-03e685dc981b";
  const assets = new AssetTools(
    config,
    async (type, data) => {
      events.push({ type, data });
    },
    new AbortController().signal,
    {
      publicFetch: async (url) => {
        requests.push(url);
        return {
          url,
          mime: url.endsWith("/thumb/") ? "image/png" : "application/json",
          body: url.endsWith("/thumb/")
            ? pixel
            : Buffer.from(
                JSON.stringify({
                  results: [
                    {
                      id,
                      title: "A <small> image",
                      creator: "<script>creator</script>",
                      foreign_landing_url: "https://example.com/original",
                      license: "by",
                      license_version: "4.0",
                      license_url:
                        "https://creativecommons.org/licenses/by/4.0/",
                    },
                  ],
                }),
              ),
        };
      },
      imageFetch: async (input, init) => {
        assert.equal(String(input), "https://openrouter.ai/api/v1/images");
        assert.equal(
          new Headers(init?.headers).get("Authorization"),
          "Bearer offline-test-key",
        );
        assert.equal(JSON.parse(String(init?.body)).n, 1);
        return new Response(
          JSON.stringify({
            data: [{ b64_json: pixel.toString("base64") }],
            usage: { cost: 0.01 },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    },
  );
  assets.tools();
  const unknown = (await assets.execute("import_image", { id })) as {
    error: string;
  };
  assert.match(unknown.error, /Search/);
  await assets.execute("search_images", { query: "tiny blue button" });
  const imported = (await assets.execute("import_image", { id })) as Asset;
  assert.equal(imported.source, "openverse");
  assert.match(imported.url, /^\/_assets\/[\w-]+\.png$/);
  assert.equal(requests.length, 2);
  const generated = (await assets.execute("generate_image", {
    prompt: "A hand-painted moon",
  })) as Asset;
  assert.equal(generated.source, "generated");
  assert.equal(generated.mime, "image/png");
  const exceeded = (await assets.execute("generate_image", {
    prompt: "Another moon",
  })) as { error: string };
  assert.match(exceeded.error, /limit/);
  assert.equal(assets.staged.length, 2);
  const value = artifact();
  value.html = value.html.replace(
    "</body>",
    `<img src="${imported.url}" alt="A tiny button"></body>`,
  );
  assert.deepEqual(validateArtifact(value, [imported]).errors, []);
  const html = renderArtifact(value, [imported]);
  assert.match(html, /&lt;script&gt;creator/);
  assert.match(html, /Image credits/);
  assert.match(html, /creativecommons/);
  assert.doesNotMatch(JSON.stringify(events), /offline-test-key|iVBOR/);
});
