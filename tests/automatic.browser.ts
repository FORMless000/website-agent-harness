import { test, expect } from "@playwright/test";

test("automatic landing, click referrer, retry, backend controls and mobile layout", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/_settings");
  await expect(
    page.getByRole("heading", { name: "Automatic generation" }),
  ).toBeVisible();
  await expect(page.locator('[name="websiteModel"]')).toHaveValue(
    "deepseek/deepseek-v4.1-flash",
  );
  await expect(page.locator('[name="descriptionModel"]')).toHaveValue(
    "deepseek/deepseek-v4.1-flash",
  );
  await expect(page.locator('[name="websiteEffort"]')).toHaveValue("low");
  await expect(page.locator('[name="descriptionEffort"]')).toHaveValue("low");
  await page.getByLabel("Allow external reference search").uncheck();
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.locator("#notice")).toContainText("Saved");
  await page.reload();
  await expect(
    page.getByLabel("Allow external reference search"),
  ).not.toBeChecked();
  await page.screenshot({
    path: "test-results/automatic-settings-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/automatic-settings-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.goto("/browser-auto");
  await expect(page.getByRole("status")).toHaveText("Loading…");
  await page.screenshot({
    path: "test-results/automatic-loading.png",
    fullPage: true,
  });
  await expect(
    page.getByRole("heading", { name: "Automatic /browser-auto", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Explore child" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Automatic /browser-auto/child",
      exact: true,
    }),
  ).toBeVisible();
  const records = await (await page.request.get("/api/automatic")).json();
  const parent = records.find((r: any) => r.path === "/browser-auto");
  const child = records.find((r: any) => r.path === "/browser-auto/child");
  expect(child.referenceReason).toBe("referring page");
  expect(child.internalReference.sessionId).toBe(parent.sessionId);
  await page.goto(`/_harness/#${parent.sessionId}`);
  await page
    .frameLocator("#preview")
    .getByRole("link", { name: "Explore preview child", exact: true })
    .click();
  await expect(
    page
      .frameLocator("#preview")
      .getByRole("link", { name: "Open page", exact: true }),
  ).toBeVisible();
  await expect(
    page.frameLocator("#preview").getByRole("heading", {
      name: "Automatic /browser-auto/preview",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("#preview")).toHaveAttribute(
    "sandbox",
    "allow-same-origin",
  );
  const previewRecords = await (
    await page.request.get("/api/automatic")
  ).json();
  const preview = previewRecords.find(
    (r: any) => r.path === "/browser-auto/preview",
  );
  expect(preview.referenceReason).toBe("referring preview");
  expect(preview.internalReference.sessionId).toBe(parent.sessionId);
  const parentSession = await (
    await page.request.get(`/api/sessions/${parent.sessionId}`)
  ).json();
  const archived = await (
    await page.request.post(`/api/sessions/${parent.sessionId}/archive`, {
      headers: { "Content-Type": "application/json", "X-Harness-Request": "1" },
      data: { versionId: parentSession.session.currentVersion },
    })
  ).json();
  await page.goto(archived.archived.url);
  await page
    .getByRole("link", { name: "Explore archive child", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Automatic /browser-auto/archive-child",
      exact: true,
    }),
  ).toBeVisible();
  const archiveRecords = await (
    await page.request.get("/api/automatic")
  ).json();
  expect(
    archiveRecords.find((r: any) => r.path === "/browser-auto/archive-child")
      .referenceReason,
  ).toBe("referring archive");
  const response = await page.request.get("/browser-auto/child");
  expect(response.headers()["content-security-policy"]).toContain(
    "script-src 'none'",
  );
  expect(response.headers()["referrer-policy"]).toBe("same-origin");
  await page.goto("/browser-auto/failure");
  await expect(page.getByRole("status")).toHaveText("Unable to load this page");
  await page.reload();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Automatic /browser-auto/failure",
      exact: true,
    }),
  ).toBeVisible();
  const after = await (await page.request.get("/api/automatic")).json();
  const retries = after.filter((r: any) => r.path === "/browser-auto/failure");
  expect(retries).toHaveLength(2);
  expect(retries[0].sessionId).toBe(retries[1].sessionId);
  await page.goto("/_settings");
  await page
    .getByRole("link", { name: "Session", exact: true })
    .first()
    .click();
  await expect(page.locator("#page-path")).toHaveText("/browser-auto/failure");
  await page.goto("/_settings");
  await page.getByText("Prompt and context resources", { exact: true }).click();
  await page
    .getByRole("link", { name: "Edit system prompts in the laboratory" })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(errors).toEqual([]);
});

test("loading shows description, reasoning, final response and elapsed time without trace text", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/browser-auto/progress");
  await expect(page.locator("#phase")).toHaveText("Generating description…");
  await expect(page.locator("#elapsed")).toHaveText(/Elapsed: [1-9]\d*s/);
  await expect(page.locator("#phase")).toHaveText("Reasoning…");
  await expect(page.locator("body")).not.toContainText(
    "private reasoning fixture",
  );
  await page.reload();
  await expect(page.locator("#elapsed")).toHaveText(/Elapsed: [1-9]\d*s/);
  await expect(page.locator("#phase")).toHaveText("Generating final response…");
  await page.screenshot({ path: "test-results/automatic-progress.png" });
  await expect(
    page.getByRole("heading", {
      name: "Automatic /browser-auto/progress",
      exact: true,
    }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
