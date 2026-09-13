import { test, expect } from "@playwright/test";

async function region(page: import("@playwright/test").Page, id: string) {
  return page.frameLocator(`iframe[data-region-id="${id}"]`);
}

test("published regions isolate state, debounce input, serialize actions, and preserve local scripts", async ({
  page,
}) => {
  const interactionRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/api/interactions/") &&
      request.method() === "POST"
    )
      interactionRequests.push(request.postData() ?? "");
  });
  await page.goto("/browser-regions");
  await expect(page.locator('iframe[data-region-id="search"]')).toBeVisible();
  const search = await region(page, "search");
  const local = await region(page, "local");
  await expect(local.getByTestId("count")).toHaveText("0");
  await expect(local.getByTestId("init")).toHaveText("1");

  const input = search.locator('input[name="q"]');
  await input.fill("museum");
  await page.waitForTimeout(150);
  expect(interactionRequests).toHaveLength(0);
  await input.fill("museums");
  await expect(search.getByTestId("search-result")).toHaveText(
    "Results for museums",
    { timeout: 3000 },
  );
  expect(interactionRequests.length).toBeGreaterThanOrEqual(1);
  await expect(local.getByTestId("count")).toHaveText("0");

  const pending = page.waitForRequest(
    (request) =>
      request.url().includes("/api/interactions/") &&
      request.postDataJSON()?.event?.inputs?.q === "first",
  );
  await input.fill("first");
  await pending;
  await input.fill("newer typing");
  await expect(input).toHaveValue("newer typing");
  await expect(search.getByTestId("search-result")).toHaveText(
    "Results for newer typing",
    { timeout: 4000 },
  );
  await expect(input).toHaveValue("newer typing");

  await local.getByRole("button", { name: "Increment" }).click();
  await local.getByRole("button", { name: "Increment" }).click();
  await expect(local.getByTestId("count")).toHaveText("2", { timeout: 3000 });
  await expect(local.getByTestId("init")).toHaveText("1");

  await local.getByRole("button", { name: "Fail" }).click();
  await expect(local.getByRole("status")).toContainText(
    "Offline interaction failure fixture",
    { timeout: 3000 },
  );
  await expect(local.getByTestId("count")).toHaveText("2");
  await local.getByRole("button", { name: "Fail" }).click();
  await expect(local.getByRole("status")).toBeHidden({ timeout: 3000 });

  const isolation = await local.locator("body").evaluate(async () => {
    let parentDocument = "accessible";
    try {
      void parent.document;
    } catch {
      parentDocument = "blocked";
    }
    const network = await fetch("https://example.com").then(
      () => "allowed",
      () => "blocked",
    );
    return { parentDocument, network };
  });
  expect(isolation.parentDocument).toBe("blocked");
  expect(isolation.network).toBe("blocked");

  await page.reload();
  const fresh = await region(page, "local");
  await expect(fresh.getByTestId("count")).toHaveText("0");
  await expect(fresh.getByTestId("init")).toHaveText("1");
});

test("regions work in the sandboxed preview iframe and generated navigation creates a destination", async ({
  page,
}) => {
  await page.goto("/browser-regions");
  const bootstrap = await (await page.request.get("/api/bootstrap")).json();
  const session = bootstrap.sessions.find(
    (entry: any) => entry.path === "/browser-regions",
  );
  expect(session?.currentVersion).toBeTruthy();
  await page.goto(`/_harness/#${session.id}`);
  const preview = page.frameLocator("#preview");
  await expect(preview.locator('iframe[data-region-id="local"]')).toBeVisible({
    timeout: 5000,
  });
  const local = preview.frameLocator('iframe[data-region-id="local"]');
  await expect(local.getByTestId("init")).toHaveText("1");
  const updated = page.waitForResponse(
    (response) =>
      response.url().includes("/api/interactions/") &&
      response.request().method() === "POST",
  );
  // Exercise keyboard activation in the nested, scrollable preview. Direct-page
  // tests above cover mouse activation and rapid repeated clicks.
  await local.getByRole("button", { name: "Increment" }).press("Enter");
  const response = await updated;
  expect(await response.json()).toMatchObject({
    revision: 1,
    state: { count: 1 },
  });
  await expect(local.getByTestId("count")).toHaveText("1", { timeout: 3000 });

  await local.getByRole("link", { name: "Open result" }).click();
  await expect(
    preview.getByRole("heading", {
      name: "Automatic \/browser-auto\/region-result",
      exact: true,
    }),
  ).toBeVisible({ timeout: 8000 });
});
