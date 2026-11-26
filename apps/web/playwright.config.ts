import { defineConfig, devices } from "@playwright/test";

// Browsers are installed into node_modules (PLAYWRIGHT_BROWSERS_PATH=0), not system-wide.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= "0";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  // Reuses a running `pnpm dev`; otherwise starts it.
  webServer: {
    command: "node ../../scripts/dev.mjs",
    url: "http://localhost:5173/api/health",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
