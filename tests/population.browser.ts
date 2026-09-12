import { test, expect } from "@playwright/test";
test("population preview, manual override preservation, references, stale results and mobile layout", async ({
  page,
}) => {
  await page.goto("/_harness/");
  await page.getByLabel("Sub-URL").fill("/test/population");
  await page.locator("#model").selectOption("1");
  await page
    .locator('textarea[name="description"]')
    .fill("Manual wins: purple.");
  await page.locator("#population-enabled").check();
  await expect(page.locator("#population-model")).toHaveValue("1");
  await page.locator("#population-suggestions").check();
  await page.locator("#populate").click();
  await expect(page.locator("#populated-brief")).toHaveValue(
    "A playful fixture brief.",
  );
  await expect(page.locator('textarea[name="description"]')).toHaveValue(
    "Manual wins: purple.",
  );
  await expect(page.locator("#population-status")).toContainText(
    "insufficient_evidence",
  );
  await expect(page.locator("#population-proposals button")).toHaveCount(2);
  await page.locator("#population-proposals button").first().click();
  await expect(page.locator("#external-references input")).toHaveValue(
    "https://example.org/reference",
  );
  await page.locator("#population-proposals button").last().click();
  await expect(page.locator("#internal-reference")).toHaveValue("");
  const traceUrl = await page
    .locator("#population-download")
    .getAttribute("href");
  const trace = await (await page.request.get(traceUrl!)).json();
  expect(trace.record.context.query.manualInstructions).toBe(
    "Manual wins: purple.",
  );
  expect(trace.events.some((e: any) => e.type === "population.end")).toBe(true);
  await page.getByLabel("Sub-URL").fill("/test/changed");
  await expect(page.locator("#population-status")).toContainText("stale");
  await page.locator("#prepare-context").click();
  await expect(page.locator("#notice")).toContainText("stale");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
