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
  await page.getByLabel("Sub-URL").fill("/museum");
  await page.getByLabel("Reasoning model").selectOption("1");
  await page
    .getByLabel("Description")
    .fill("A tiny museum of ordinary things.");
  await page.getByRole("button", { name: "Generate website" }).click();
  await expect(page.locator("#run-status")).toHaveText("success");
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
  await page.getByRole("button", { name: "Exact context" }).click();
  await expect(page.locator("#trace")).toContainText("system.md");
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
  expect(errors).toEqual([]);
});
test("mobile workspace does not overflow horizontally", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/_harness/");
  await page.getByLabel("Sub-URL").fill("/mobile");
  await page.getByLabel("Reasoning model").selectOption("3");
  await page.getByRole("button", { name: "Generate website" }).click();
  await expect(page.locator("#run-status")).toHaveText("success");
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
});
