import { defineConfig, devices } from "@playwright/test";

const e2ePort = Number(process.env.HARNEST_E2E_PORT ?? "3100");
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: "./e2e",
  testIgnore: "runtime.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: "line",
  use: {
    baseURL: e2eBaseUrl,
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node e2e/start-studio.mjs",
    cwd: ".",
    url: `${e2eBaseUrl}/builder`,
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
