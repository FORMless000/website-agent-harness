import { test, expect } from "@playwright/test";
test("create, preview, edit, historical source, trace and editable prompts", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/_harness/");
  await expect(
    page.getByRole("heading", { name: "What lives at this URL?" }),
  ).toBeVisible();
  await expect(page.locator("#model")).toHaveValue("");
  await expect(page.locator("#internal-compression")).toHaveValue("clean");
  await page.getByLabel("Sub-URL").fill("/museum");
  await page.getByLabel("Reasoning model").selectOption("1");
  await page
    .locator('textarea[name="description"]')
    .fill("A tiny museum of ordinary things.");
  await page.getByRole("button", { name: "Generate website" }).click();
  await expect(page.locator("#run-status")).toHaveText("success");
  await expect(page.locator("#page-description")).toContainText("small museum");
  await expect(page.locator("#context-stats")).toContainText(
    "Context estimate:",
  );
  await expect(page.locator("#cache-stats")).toContainText("cache read 0");
  await expect(page.locator("#cache-stats")).toContainText(
    "cache write not reported",
  );
  await expect(
    page
      .frameLocator("#preview")
      .getByRole("heading", { name: "A tiny museum", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/workspace-desktop.png",
    fullPage: true,
  });
  await page.locator("#message").fill("Make the title smaller and stranger.");
  await page.getByRole("button", { name: "Send edit" }).click();
  await expect(
    page.frameLocator("#preview").getByRole("heading", {
      name: "A smaller, stranger museum",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("#versions option")).toHaveCount(2);
  await page.locator("#versions").selectOption({ label: "v1" });
  await expect(
    page
      .frameLocator("#preview")
      .getByRole("heading", { name: "A tiny museum", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "HTML", exact: true }).click();
  await expect(page.locator("#source")).toContainText("<!doctype html>");
  await page
    .getByRole("button", { name: "Outgoing request", exact: true })
    .click();
  await expect(page.locator("#requests option")).toHaveCount(1);
  await expect(page.locator("#trace")).toContainText("submit_website");
  await page.getByRole("button", { name: "Prompt sources" }).click();
  await expect(page.locator("#trace")).toContainText("system.md");
  await expect(page.locator("#requests")).toBeHidden();
  await page.getByRole("button", { name: "Model metadata" }).click();
  await expect(page.locator("#trace-note")).toContainText("not sent wholesale");
  await page.locator("#runs").selectOption({ index: 0 });
  await page.getByRole("button", { name: "Reasoning / text" }).click();
  await expect(page.locator("#trace")).toContainText("responsive grid");
  await page.getByRole("button", { name: "SDK state" }).click();
  await expect(page.locator("#trace")).toContainText("opaque-test-value");
  await page.getByRole("button", { name: "Edit system prompts" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const original = await page.locator("#prompt-content").inputValue();
  await page
    .locator("#prompt-content")
    .fill(original + "\n\nTest-only prompt edit.");
  await page.getByRole("button", { name: "Save prompt" }).click();
  await expect(page.locator("#prompt-status")).toContainText("Saved");
  await page.getByRole("button", { name: "Close prompts" }).click();
  await page.reload();
  await expect(page.locator("#page-path")).toHaveText("/museum");
  await expect(page.locator("#messages")).toContainText(
    "Make the title smaller and stranger.",
  );
  // Replay the existing log shape; the UI must not require a storage migration.
  let omitRequest = false;
  const readableFixture = {
    fixture: "second request only",
    input: JSON.stringify({
      parent: { html: '<html lang="en">\n\t<body>Text</body>\n</html>' },
    }),
    literal: String.raw`C:\new\test`,
    invalidJson: "{not JSON}",
  };
  await page.route("**/api/runs/*", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const request = data.events.find(
      (e: { type: string }) => e.type === "request",
    );
    if (omitRequest) {
      data.events = data.events.filter(
        (e: { type: string }) =>
          ![
            "request",
            "context.prepared",
            "context.comparison",
            "cache.policy",
          ].includes(e.type),
      );
      for (const event of data.events)
        if (event.type === "step.end") event.data.usage = {};
    } else {
      data.events.push({
        ...request,
        seq: data.events.at(-1).seq + 1,
        data: { ...request.data, body: readableFixture },
      });
      for (const delta of [
        "The user wants /tom",
        "orrow/",
        "astro.",
        "\n\nKeep this paragraph.",
      ]) {
        data.events.push({
          type: "provider.event",
          data: {
            type: "response.reasoning_text.delta",
            item_id: "readability-test",
            content_index: 0,
            delta,
          },
        });
      }
      data.events.push({
        type: "provider.event",
        data: {
          type: "response.reasoning_text.done",
          item_id: "readability-test",
          content_index: 0,
          text: "The user wants /tomorrow/astro.\n\nKeep this paragraph.",
        },
      });
    }
    await route.fulfill({ response, json: data });
  });
  await page.reload();
  await expect(page.locator("#requests option")).toHaveCount(2);
  await expect(page.locator("#trace")).not.toContainText("second request only");
  await page.getByLabel("Outgoing request", { exact: true }).selectOption("1");
  await expect(page.locator("#trace")).toHaveText(
    JSON.stringify(readableFixture, null, 2),
  );
  await page.getByLabel("Readable strings").check();
  const readable = await page.locator("#trace").textContent();
  expect(readable).toContain("[JSON string]");
  expect(readable).toContain('<html lang="en">\n');
  expect(readable).toContain("\t<body>Text</body>");
  expect(readable).toContain(String.raw`C:\new\test`);
  expect(readable).toContain("{not JSON}");
  await expect(page.locator("#trace html")).toHaveCount(0);
  await expect(page.locator("#trace-note")).toContainText(
    "not valid request JSON",
  );
  await page.getByLabel("Readable strings").uncheck();
  await expect(page.locator("#trace")).toHaveText(
    JSON.stringify(readableFixture, null, 2),
  );
  await page.getByRole("button", { name: "Prompt sources" }).click();
  await expect(page.locator("#trace")).toContainText("system.md");
  await page
    .getByRole("button", { name: "Outgoing request", exact: true })
    .click();
  await expect(page.locator("#requests")).toHaveValue("1");
  await page.getByRole("button", { name: "Reasoning / text" }).click();
  const joinedReasoning = await page.locator("#trace").textContent();
  expect(joinedReasoning).toContain(
    "The user wants /tomorrow/astro.\n\nKeep this paragraph.",
  );
  expect(joinedReasoning?.match(/The user wants/g)).toHaveLength(1);
  expect(joinedReasoning).not.toContain("response.reasoning_text");
  await page
    .getByRole("button", { name: "Outgoing request", exact: true })
    .click();
  await page.locator("#runs").selectOption({ index: 0 });
  await expect(page.locator("#requests")).toHaveValue("0");
  omitRequest = true;
  await page.reload();
  await expect(page.locator("#trace")).toContainText(
    "cannot reconstruct the exact payload",
  );
  await expect(page.locator("#requests")).toBeDisabled();
  await expect(page.locator("#cache-stats")).toContainText(
    "cache read not reported",
  );
  await expect(page.locator("#context-stats")).toContainText("not recorded");
  await page.getByRole("button", { name: "Prompt sources" }).click();
  await expect(page.locator("#trace")).toContainText("system.md");
  expect(errors).toEqual([]);
});
test("mobile workspace does not overflow horizontally", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/_harness/");
  await page.getByLabel("Sub-URL").fill("/mobile");
  await page
    .getByLabel("Internal reference", { exact: true })
    .selectOption({ index: 1 });
  await page
    .getByLabel("Internal compression", { exact: true })
    .selectOption("structure");
  await page.getByLabel("Reasoning model").selectOption("3");
  await page.getByRole("button", { name: "Prepare / compare context" }).click();
  await expect(page.locator("#preparation-summary")).toContainText(
    "Whole request",
  );
  await expect(page.locator("#preparation-summary")).toContainText("brief:");
  await page.getByRole("button", { name: "Generate website" }).click();
  await expect(page.locator("#run-status")).toHaveText("success");
  await expect(page.locator("#context-stats")).toContainText(
    "Context estimate:",
  );
  await expect(page.locator("#context-stats")).toContainText("tokens");
  await expect(page.locator("#cache-stats")).toContainText(
    "eligible for reuse",
  );
  await expect(
    page
      .frameLocator("#preview")
      .getByRole("heading", { name: "Mobile museum", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/workspace-mobile.png",
    fullPage: true,
  });
  await expect(page.locator("#style-decision")).toContainText(
    "CSS decision: new",
  );
  const internal = await page.locator("#internal-reference").inputValue();
  await page.getByRole("button", { name: "＋ New" }).click();
  await expect(page.locator("#internal-reference")).toHaveValue(internal);
  await page.locator("#sessions button").filter({ hasText: "/mobile" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Archive selected version & release URL" })
    .click();
  await expect(page.locator("#open-page")).toHaveAttribute(
    "href",
    /\/_archive\//,
  );
  await expect(page.locator("#send")).toBeDisabled();
  await expect(page.locator("#session-filter")).toHaveValue("archived");
});
