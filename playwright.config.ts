import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  testMatch: "*.browser.ts",
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:18788",
    headless: true,
    channel: process.env.HARNESS_BROWSER_CHANNEL,
    viewport: { width: 1440, height: 1080 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node --import tsx tests/browser-server.ts",
    url: "http://127.0.0.1:18788/api/bootstrap",
    reuseExistingServer: false,
    timeout: 15000,
  },
});
