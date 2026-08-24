import { expect, test, type Page } from "@playwright/test";

const now = "2026-08-24T09:00:00.000Z";
const emptySpec = {
  version: "0.2",
  components: [],
  connections: [],
  entrypoint: "",
  tests: [],
  studio: { positions: {} },
};

const specPayload = (exists = true) => ({
  spec: emptySpec,
  yaml: 'version: "0.2"\ncomponents: []\nconnections: []\nentrypoint: ""\n',
  file: "e2e.yaml",
  exists,
  diagnostics: [],
});

async function useEnglish(page: Page) {
  await page.context().addCookies([{
    name: "harnest.studio.locale",
    value: "en-US",
    url: "http://127.0.0.1:3000",
  }]);
}

async function mockSafeSpec(page: Page, exists = true, onSave?: () => void) {
  await page.route("**/api/spec", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ json: specPayload(exists) });
    else {
      onSave?.();
      await route.fulfill({ json: { ok: true, diagnostics: [] } });
    }
  });
  await page.route("**/api/validate", (route) => route.fulfill({ json: { ok: true, diagnostics: [] } }));
}

async function mockPlayground(page: Page) {
  let ran = false;
  const capabilities = {
    models: [{ componentKey: "root/model", componentId: "model", connectionId: "gemini", model: "gemini-2.5-flash", label: "gemini-2.5-flash · primary", fallback: false }],
    plugins: [],
    attachments: { enabled: false, maxFiles: 32, maxFileBytes: 67_108_864, accepted: "", reason: "Attach a Code Runner" },
  };
  const session = () => ({
    id: "e2e-session",
    title: "Gemini smoke test",
    createdAt: now,
    updatedAt: now,
    expiresAt: "2026-09-23T09:00:00.000Z",
    messages: ran ? [
      { id: "user-1", role: "user", content: "Say hello", createdAt: now },
      { id: "assistant-1", role: "assistant", content: "Mock Gemini response", createdAt: now, runId: "mock-run", usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 }, finishReason: "stop" },
    ] : [],
  });
  await page.route("**/api/playground*", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "POST") return route.fulfill({ json: { session: session() } });
    if (url.searchParams.has("sessionId")) return route.fulfill({ json: { ready: true, diagnostics: [], capabilities, retentionDays: 30, session: session(), files: [] } });
    return route.fulfill({ json: { ready: true, diagnostics: [], capabilities, retentionDays: 30, sessions: [{ ...session(), messages: undefined, messageCount: ran ? 2 : 0, preview: ran ? "Mock Gemini response" : "" }] } });
  });
  await page.route("**/api/playground/run", async (route) => {
    ran = true;
    const events = [
      { type: "run-start", runId: "mock-run", timestamp: now, input: "Say hello", specVersion: "0.2" },
      { type: "text-delta", runId: "mock-run", timestamp: now, nodeId: "model", text: "Mock Gemini response", iteration: 0 },
      { type: "run-end", runId: "mock-run", timestamp: now, output: "Mock Gemini response", state: {}, usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 }, costUsd: 0, iterations: 1, durationMs: 12, finishReason: "stop" },
    ];
    await route.fulfill({ status: 200, contentType: "application/x-ndjson", body: `${events.map((event) => JSON.stringify(event)).join("\n")}\n` });
  });
}

test.beforeEach(async ({ page }) => useEnglish(page));

test("new project → recipe → Gemini-shaped first streamed response", async ({ page }) => {
  await mockSafeSpec(page, false);
  await mockPlayground(page);
  await page.goto("/builder");
  await expect(page.getByRole("heading", { name: "Start from the result you want." })).toBeVisible();
  await page.locator(".recipe-card").first().click();
  await expect(page.locator(".h-node").first()).toBeVisible();
  await page.goto("/playground");
  await page.getByLabel("Message the harness").fill("Say hello");
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(page.getByText("Mock Gemini response", { exact: true }).last()).toBeVisible();
});

test("Firecrawl and MCP OAuth are discoverable without manual schema entry", async ({ page }) => {
  await mockSafeSpec(page);
  await page.route("**/api/connections", (route) => route.request().method() === "GET" ? route.fulfill({ json: { connections: [] } }) : route.continue());
  await page.goto("/settings?section=connections");
  await page.getByRole("button", { name: "Manage services" }).click();
  await page.getByRole("button", { name: "Add service" }).first().click();
  await page.getByRole("button", { name: /Web Search/ }).click();
  await expect(page.getByRole("option", { name: "Firecrawl" })).toBeAttached();
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Add service" }).first().click();
  await page.getByRole("button", { name: /^MCP server/ }).first().click();
  await expect(page.getByRole("option", { name: "Browser sign-in" })).toBeAttached();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/settings\?section=connections$/);
  await expect(page.getByRole("heading", { name: "Connections", exact: true, level: 2 })).toBeVisible();
});

test("expired, insufficient-scope, and revocation-pending states expose recovery", async ({ page }) => {
  await mockSafeSpec(page);
  const connection = (id: string, status: string) => ({ id, name: id, kind: "provider", scope: "project", status, config: { adapter: "gemini", model: "gemini-2.5-flash" }, credentialFields: ["apiKey"], credentialPresence: { apiKey: true } });
  await page.route("**/api/connections", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { connections: [connection("ready", "connected"), connection("expired", "expired"), connection("scope", "insufficient_scope"), connection("revoke", "revocation_pending")] } })
    : route.continue());
  await page.goto("/settings?section=connections");
  await page.getByRole("button", { name: "Manage services" }).click();
  await expect(page.getByText("Authentication expired", { exact: true })).toBeVisible();
  await expect(page.getByText("More permissions required", { exact: true })).toBeVisible();
  await expect(page.getByText("Disconnect pending", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Test connection" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in again" }).first()).toBeVisible();
});

test("autosave ignores navigation boundaries and URL history remains restorable", async ({ page }) => {
  let saves = 0;
  const promptSpec = {
    ...emptySpec,
    components: [{ id: "prompt", type: "prompt", config: { template: "Hello {{input}}" } }],
    entrypoint: "prompt",
    studio: { positions: { prompt: { x: 80, y: 80 } } },
  };
  await page.route("**/api/spec", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ json: { ...specPayload(true), spec: promptSpec } });
    else { saves += 1; await route.fulfill({ json: { ok: true, diagnostics: [] } }); }
  });
  await page.route("**/api/validate", (route) => route.fulfill({ json: { ok: true, diagnostics: [] } }));
  await page.goto("/builder");
  await page.locator(".h-node").click();
  await page.locator(".inspector-panel textarea").first().fill("Changed {{input}}");
  await expect.poll(() => saves).toBeGreaterThan(0);
  await page.getByRole("link", { name: "Runs" }).click();
  await expect(page).toHaveURL(/\/runs$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/builder$/);
  await page.reload();
  await expect(page).toHaveURL(/\/builder$/);
});

test("initial API failure and empty run history have explicit retry/empty states", async ({ page }) => {
  let fail = true;
  await page.route("**/api/spec", (route) => fail
    ? route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE", message: "Studio unavailable", recoverable: true } } })
    : route.fulfill({ json: specPayload(true) }));
  await page.goto("/builder");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator(".studio-shell")).toBeVisible();
  await page.route("**/api/runs", (route) => route.fulfill({ json: { runs: [] } }));
  await page.goto("/runs");
  await expect(page.getByText("No persisted runs yet", { exact: true }).first()).toBeVisible();
});

test("ko/en, light/dark, mobile layout, and keyboard navigation update at runtime", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings?section=general");
  await page.getByLabel("Display language").selectOption("ko-KR");
  await expect(page.locator("html")).toHaveAttribute("lang", "ko-KR");
  await expect(page.getByRole("heading", { name: "일반" })).toBeVisible();
  await page.getByRole("radio", { name: "다크" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
  await expect(page.locator('[aria-live="polite"]').first()).toBeAttached();
  const unnamedButtons = await page.locator("button:visible").evaluateAll((buttons) => buttons
    .filter((button) => !button.getAttribute("aria-label") && !button.getAttribute("title") && !button.textContent?.trim())
    .map((button) => button.outerHTML));
  expect(unnamedButtons).toEqual([]);
});
