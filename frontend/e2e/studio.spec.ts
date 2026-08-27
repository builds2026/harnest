import { expect, test, type Page } from "@playwright/test";

const now = "2026-08-24T09:00:00.000Z";
const e2eBaseUrl = `http://127.0.0.1:${Number(process.env.HARNEST_E2E_PORT ?? "3100")}`;
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
    url: e2eBaseUrl,
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

async function mockPlayground(page: Page, options: { resources?: boolean } = {}) {
  let ran = false;
  const capabilities = {
    models: [{ componentKey: "root/model", componentId: "model", connectionId: "gemini", model: "gemini-2.5-flash", label: "gemini-2.5-flash · primary", fallback: false }],
    plugins: options.resources ? [{ componentKey: "root/search", componentId: "search", id: "builtin.web-search", label: "Web search", kind: "tool", risk: "network" }] : [],
    attachments: { enabled: Boolean(options.resources), directModelInput: Boolean(options.resources), maxFiles: 32, maxFileBytes: 67_108_864, accepted: options.resources ? "image/*,.pdf,text/plain" : "", reason: options.resources ? undefined : "Attach a Code Runner" },
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

test("Builder catalog tabs support keyboard navigation", async ({ page }) => {
  const spec = {
    ...emptySpec,
    components: [{ id: "prompt", type: "prompt", config: { template: "{{input}}" } }],
    entrypoint: "prompt",
    studio: { positions: { prompt: { x: 80, y: 80 } } },
  };
  await page.route("**/api/spec", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { ...specPayload(true), spec } })
    : route.fulfill({ json: { ok: true, diagnostics: [] } }));
  await page.route("**/api/validate", (route) => route.fulfill({ json: { ok: true, diagnostics: [] } }));
  await page.route("**/api/connections", (route) => route.fulfill({ json: { connections: [] } }));
  await page.goto("/builder");
  await page.getByRole("button", { name: /Add$/ }).click();

  const build = page.getByRole("tab", { name: "Build" });
  const tools = page.getByRole("tab", { name: "Tools" });
  const skills = page.getByRole("tab", { name: "Skills" });
  await build.focus();
  await page.keyboard.press("ArrowRight");
  await expect(tools).toBeFocused();
  await expect(tools).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(skills).toBeFocused();
  await expect(skills).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Manage skills" })).toBeVisible();
});

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

test("Integrate presents the three supported production surfaces consistently", async ({ page }) => {
  await mockSafeSpec(page);
  await page.route("**/api/connections", (route) => route.fulfill({ json: { connections: [] } }));
  await page.goto("/integrate");

  await expect(page.getByText("3 surfaces", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "One harness. Three production surfaces." })).toBeVisible();
  const recipes = page.locator(".integration-snippets article");
  await expect(recipes).toHaveCount(3);
  await expect(recipes.locator("strong")).toHaveText(["TypeScript SDK", "CLI", "HTTP"]);
  await expect(page.getByText("MCP", { exact: true })).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) {
  test(`Playground details stay reachable at 1024px in ${theme} mode`, async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.addInitScript((value) => localStorage.setItem("harnest.studio.theme", value), theme);
    await mockPlayground(page);
    await page.goto("/playground");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

    await page.getByRole("button", { name: "Files", exact: true }).click();
    const controls = [
      page.getByRole("complementary", { name: "Files and sandbox" }),
      page.getByRole("tab", { name: "Details" }),
      page.getByRole("button", { name: "Collapse files" }),
      page.getByRole("button", { name: "Refresh harness support" }),
      page.getByRole("button", { name: "Open Builder" }),
    ];

    for (const control of controls) {
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(1024);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(768);
    }

    await expect.poll(() => page.evaluate(() => ({
      body: document.body.scrollWidth <= document.body.clientWidth,
      document: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    }))).toEqual({ body: true, document: true });
  });
}

test("Playground resource tabs and capability popover support the keyboard", async ({ page }) => {
  await mockPlayground(page, { resources: true });
  await page.goto("/playground");

  const uploads = page.getByRole("tab", { name: /Uploads/ });
  const sandbox = page.getByRole("tab", { name: /Sandbox/ });
  const details = page.getByRole("tab", { name: "Details" });
  await uploads.focus();
  await page.keyboard.press("ArrowRight");
  await expect(sandbox).toBeFocused();
  await expect(sandbox).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(details).toBeFocused();
  await expect(details).toHaveAttribute("aria-selected", "true");

  const capabilities = page.getByRole("button", { name: /Capabilities/ });
  await capabilities.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Run capabilities", { exact: true })).toBeVisible();
  await expect(page.getByText("Web search", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Run capabilities", { exact: true })).toHaveCount(0);
  await expect(capabilities).toBeFocused();
});

test("Builder Live queues interactions, sends permission decisions, and locks graph editing", async ({ page }) => {
  const spec = {
    ...emptySpec,
    components: [{ id: "prompt", type: "prompt", config: { template: "{{input}}" } }],
    entrypoint: "prompt",
    studio: { positions: { prompt: { x: 80, y: 80 } } },
  };
  await page.route("**/api/spec", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { ...specPayload(true), spec } })
    : route.fulfill({ json: { ok: true, diagnostics: [] } }));
  await page.route("**/api/validate", (route) => route.fulfill({ json: { ok: true, diagnostics: [], plan: { nodeCount: 1, layerCount: 1, entrypoint: "prompt" } } }));
  await page.route("**/api/runs", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 202, json: { runId: "live-interactions", events: "/mock-live-events" } })
    : route.fulfill({ json: { runs: [] } }));
  const requests = [
    {
      type: "interaction-requested", runId: "live-interactions", timestamp: now, sequence: 1,
      request: {
        id: "permission", runId: "live-interactions", nodeId: "prompt", kind: "permission",
        requester: { kind: "tool", id: "tool" }, title: "Approve tool", message: "Allow this tool?", blocking: "run",
        checkpoint: { revision: 0, sequence: 1, digest: "permission-digest" }, createdAt: now,
        data: { previewLimited: false, resourceResolved: true },
      },
    },
    {
      type: "interaction-requested", runId: "live-interactions", timestamp: now, sequence: 2,
      request: {
        id: "input", runId: "live-interactions", nodeId: "prompt", kind: "input",
        requester: { kind: "harness", id: "prompt" }, title: "Clarify request", message: "What should change?", blocking: "run",
        schema: { type: "string" }, checkpoint: { revision: 0, sequence: 2, digest: "input-digest" }, createdAt: now,
      },
    },
    { type: "run-paused", runId: "live-interactions", timestamp: now, sequence: 3, paused: true, interactionId: "permission" },
  ];
  await page.route("**/mock-live-events", (route) => route.fulfill({
    status: 200,
    contentType: "application/x-ndjson",
    body: `${requests.map((event) => JSON.stringify(event)).join("\n")}\n`,
  }));
  const commands: Array<Record<string, unknown>> = [];
  await page.route("**/api/runs/live-interactions/commands", async (route) => {
    commands.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ json: { ok: true } });
  });

  await page.goto("/builder");
  await page.getByRole("button", { name: "Live" }).click();
  await page.getByLabel("Run request").fill("Run it");
  const start = page.getByRole("button", { name: "Start run" });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByRole("alertdialog")).toContainText("Approve tool");
  await expect(page.locator(".canvas-mode button").first()).toBeDisabled();
  await page.getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByRole("heading", { name: "Clarify request" })).toBeVisible();
  await page.getByLabel("Response").fill("Use the queued answer");
  await page.getByRole("button", { name: "Submit response" }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[0]).toMatchObject({
    type: "interaction-response",
    response: { interactionId: "permission", action: "submit", permission: "allow_once" },
  });
  expect(commands[1]).toMatchObject({
    type: "interaction-response",
    response: { interactionId: "input", action: "submit", value: "Use the queued answer" },
  });
});

test("Settings closes to its originating surface with a Builder fallback", async ({ page }) => {
  await mockSafeSpec(page);
  await page.route("**/api/runs", (route) => route.fulfill({ json: { runs: [] } }));
  await page.goto("/runs");
  await page.getByRole("link", { name: /Settings/ }).click();
  await expect(page).toHaveURL(/\/settings\?section=general$/);
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await expect(page).toHaveURL(/\/runs$/);

  await page.goto("/settings?section=general");
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await expect(page).toHaveURL(/\/builder$/);
});

test("Settings opens Tool and Skill managers and returns to the same section", async ({ page }) => {
  await mockSafeSpec(page);
  await page.route("**/api/tools", (route) => route.fulfill({ json: { tools: [] } }));
  await page.route("**/api/skills", (route) => route.fulfill({ json: { skills: [], warnings: [] } }));
  await page.goto("/settings?section=tools");

  await page.getByRole("button", { name: "Manage tools" }).click();
  const tools = page.getByRole("dialog", { name: "Custom tools" });
  await expect(tools).toBeVisible();
  await expect(tools.getByRole("button", { name: "New custom tool" }).first()).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/settings\?section=tools$/);
  await expect(page.getByRole("heading", { name: "Tools & skills", level: 2 })).toBeVisible();

  await page.getByRole("button", { name: "Manage skills" }).click();
  const skills = page.getByRole("dialog", { name: "Skills" });
  await expect(skills).toBeVisible();
  await skills.getByRole("button", { name: "Close skills" }).click();
  await expect(page).toHaveURL(/\/settings\?section=tools$/);
  await expect(page.getByRole("heading", { name: "Tools & skills", level: 2 })).toBeVisible();
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
  const manager = page.getByRole("dialog", { name: "Services" });
  await expect(manager.getByText("Authentication expired", { exact: true })).toBeVisible();
  await expect(manager.getByText("More permissions required", { exact: true })).toBeVisible();
  await expect(manager.getByText("Disconnect pending", { exact: true })).toBeVisible();
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
  const editor = page.locator(".inspector-panel textarea").first();
  await editor.fill("Changed once {{input}}");
  await editor.fill("Changed twice {{input}}");
  await editor.fill("Changed finally {{input}}");
  await expect.poll(() => saves).toBe(1);
  await page.waitForTimeout(1_400);
  expect(saves).toBe(1);

  const node = page.locator(".h-node").first();
  const box = await node.boundingBox();
  if (!box) throw new Error("Harness node is not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + 28);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + 88, { steps: 24 });
  expect(saves).toBe(1);
  await page.mouse.up();
  await expect.poll(() => saves).toBe(2);
  await page.waitForTimeout(1_400);
  expect(saves).toBe(2);

  await page.getByRole("link", { name: "Runs" }).click();
  await expect(page).toHaveURL(/\/runs$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/builder$/);
  await page.reload();
  await expect(page).toHaveURL(/\/builder$/);
});

test("auto arrange lays out every node without the nested ELK worker error", async ({ page }) => {
  const spec = {
    ...emptySpec,
    version: "0.3",
    components: [
      { id: "model", type: "model", config: { connection: "model-main" } },
      { id: "prompt", type: "prompt", config: { template: "{{input}}" } },
      { id: "agent", type: "agent", config: { system: "Answer clearly." } },
      { id: "output", type: "output", config: {} },
    ],
    connections: [
      { from: { component: "model", port: "model" }, to: { component: "agent", port: "model" } },
      { from: { component: "prompt", port: "prompt" }, to: { component: "agent", port: "prompt" } },
      { from: { component: "agent", port: "response" }, to: { component: "output", port: "value" } },
    ],
    entrypoint: "agent",
    studio: { positions: { model: { x: 500, y: 30 }, prompt: { x: 30, y: 500 }, agent: { x: 50, y: 40 }, output: { x: 400, y: 450 } } },
  };
  await page.route("**/api/spec", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { ...specPayload(true), spec } })
    : route.fulfill({ json: { ok: true, diagnostics: [] } }));
  await page.route("**/api/validate", (route) => route.fulfill({ json: { ok: true, diagnostics: [] } }));
  await page.goto("/builder");
  const nodes = page.locator(".react-flow__node");
  await expect(nodes).toHaveCount(4);
  const before = await nodes.evaluateAll((items) => items.map((item) => (item as HTMLElement).style.transform));
  const autoArrange = page.getByRole("button", { name: "Auto arrange" });
  await autoArrange.click();
  const layoutToast = page.getByText("Graph arranged. Undo restores every previous position.").last();
  await expect(layoutToast).toBeVisible();
  await layoutToast.hover();
  const dismissToast = page.locator('button[aria-label="Dismiss"]');
  await expect(dismissToast).toBeVisible();
  await dismissToast.click();
  await expect(dismissToast).toHaveCount(0);
  await expect(autoArrange).toBeEnabled();
  await expect.poll(() => nodes.evaluateAll((items) => items.map((item) => (item as HTMLElement).style.transform))).not.toEqual(before);
  await expect(page.getByText(/_Worker is not a constructor/)).toHaveCount(0);
  const boxes = Object.fromEntries(await nodes.evaluateAll((items) => items.map((item) => {
    const box = item.getBoundingClientRect();
    return [item.getAttribute("data-id"), { x: box.x, right: box.right }];
  })));
  expect(Math.max(boxes.model.x, boxes.prompt.x)).toBeLessThan(boxes.agent.x);
  expect(boxes.agent.right).toBeLessThan(boxes.output.x);
  await page.getByRole("button", { name: "Undo last canvas change" }).click();
  await expect.poll(() => nodes.evaluateAll((items) => items.map((item) => (item as HTMLElement).style.transform))).toEqual(before);
});

test("auto arrange preserves legacy HarnessSpec versions", async ({ page }) => {
  const spec = {
    ...emptySpec,
    components: [
      { id: "prompt", type: "prompt", config: { template: "{{input}}" } },
      { id: "output", type: "output", config: {} },
    ],
    connections: [{ from: { component: "prompt", port: "prompt" }, to: { component: "output", port: "value" } }],
    entrypoint: "prompt",
    studio: { positions: { prompt: { x: 400, y: 300 }, output: { x: 40, y: 40 } } },
  };
  let savedYaml = "";
  await page.route("**/api/spec", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ json: { ...specPayload(true), spec } });
    else {
      savedYaml = (route.request().postDataJSON() as { yaml: string }).yaml;
      await route.fulfill({ json: { ok: true, diagnostics: [] } });
    }
  });
  await page.route("**/api/validate", (route) => route.fulfill({ json: { ok: true, diagnostics: [] } }));
  await page.goto("/builder");
  await page.getByRole("button", { name: "Auto arrange" }).click();
  await expect.poll(() => savedYaml).toMatch(/version:\s+["']?0\.2/);
  expect(savedYaml).not.toMatch(/version:\s+["']?0\.3/);
});

test("v0.3 graph authoring renames and pins components and manages subgraphs safely", async ({ page }) => {
  const spec = {
    ...emptySpec,
    version: "0.3",
    components: [
      { id: "prompt", type: "prompt", config: { template: "{{input}}" } },
      { id: "call", type: "subgraph", config: { subgraph: "review" } },
    ],
    entrypoint: "prompt",
    subgraphs: {
      review: {
        components: [{ id: "review_prompt", type: "prompt", config: { template: "Review {{input}}" } }],
        connections: [],
        entrypoint: "review_prompt",
      },
    },
    studio: {
      positions: { prompt: { x: 80, y: 80 }, call: { x: 400, y: 80 } },
      pinned: ["prompt"],
      direction: "RIGHT",
      subgraphs: { review: { positions: { review_prompt: { x: 80, y: 80 } }, pinned: ["review_prompt"] } },
    },
  };
  await page.route("**/api/spec", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { ...specPayload(true), spec } })
    : route.fulfill({ json: { ok: true, diagnostics: [] } }));
  await page.route("**/api/validate", (route) => route.fulfill({ json: { ok: true, diagnostics: [] } }));
  await page.goto("/builder");

  await page.locator('.react-flow__node[data-id="prompt"]').click();
  await expect(page.getByLabel("Pinned position")).toBeVisible();
  await page.getByRole("button", { name: "Unpin position" }).click();
  await expect(page.getByLabel("Pinned position")).toHaveCount(0);
  await page.getByRole("button", { name: "Pin position" }).click();
  const componentId = page.getByLabel("Component ID");
  await componentId.fill("request");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.locator('.react-flow__node[data-id="request"]')).toBeVisible();
  await componentId.fill("call");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.getByText("Another component in this graph already uses that ID.")).toBeVisible();

  await page.getByLabel("Layout direction").click();
  await page.getByRole("option", { name: "Top to bottom" }).click();
  await expect(page.getByLabel("Layout direction")).toContainText("Top to bottom");

  await page.getByLabel("Open graph").click();
  await page.getByRole("option", { name: "review" }).click();
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  const renameDialog = page.getByRole("alertdialog");
  await renameDialog.getByLabel("Subgraph name").fill("audit");
  await renameDialog.getByRole("button", { name: "Rename subgraph" }).click();
  await expect(page).toHaveURL(/\/builder\?graph=audit$/);

  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const deleteDialog = page.getByRole("alertdialog");
  await expect(deleteDialog).toContainText("1 referencing components");
  await deleteDialog.getByRole("button", { name: "Delete subgraph" }).click();
  await expect(page).toHaveURL(/\/builder$/);
  await expect(page.locator('.react-flow__node[data-id="call"]')).toHaveCount(0);
});

test("v0.3 Definitions create, rename, and safely delete agent and Team references", async ({ page }) => {
  const spec = {
    ...emptySpec,
    version: "0.3",
    components: [
      { id: "teamCall", type: "team", config: { team: "engineering" } },
      { id: "output", type: "output", config: {} },
    ],
    connections: [{ from: { component: "teamCall", port: "value" }, to: { component: "output", port: "value" } }],
    entrypoint: "teamCall",
    subgraphs: {
      runner: { components: [{ id: "result", type: "output", config: {} }], connections: [], entrypoint: "result" },
    },
    agentTemplates: {
      chief: { description: "Plans work", runner: { subgraph: "runner" } },
      worker: { description: "Does work", runner: { subgraph: "runner" } },
    },
    teams: { engineering: { orchestrator: "chief", members: ["worker"], limits: { maxParallel: 2 } } },
    studio: { positions: { teamCall: { x: 80, y: 80 }, output: { x: 400, y: 80 } }, subgraphs: { runner: { positions: { result: { x: 80, y: 80 } } } } },
  };
  await page.route("**/api/spec", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { ...specPayload(true), spec } })
    : route.fulfill({ json: { ok: true, diagnostics: [] } }));
  await page.route("**/api/validate", (route) => route.fulfill({ json: { ok: true, diagnostics: [] } }));
  await page.goto("/builder");
  await page.getByRole("tab", { name: "Definitions" }).click();
  const agents = page.getByRole("region", { name: "Agent templates" });
  const teams = page.getByRole("region", { name: "Teams" });

  const chief = agents.locator("details").filter({ hasText: "chief" });
  await chief.locator("summary").click();
  await chief.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("dialog").getByLabel("Definition ID").fill("lead");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(agents.getByText("lead", { exact: true })).toBeVisible();

  await agents.getByRole("button", { name: "New agent template" }).click();
  const templateDialog = page.getByRole("dialog");
  await templateDialog.getByLabel("Definition ID").fill("reviewer");
  await templateDialog.getByLabel("Description").fill("Reviews results");
  await templateDialog.getByRole("button", { name: "Save" }).click();
  await expect(agents.getByText("reviewer", { exact: true })).toBeVisible();

  const engineering = teams.locator("details").filter({ hasText: "engineering" });
  await engineering.locator("summary").click();
  await engineering.getByRole("button", { name: "Edit" }).click();
  const teamDialog = page.getByRole("dialog");
  await teamDialog.getByLabel("Definition ID").fill("review");
  await teamDialog.getByRole("checkbox", { name: "reviewer" }).check();
  await teamDialog.getByRole("button", { name: "Save" }).click();
  await expect(teams.getByText("review", { exact: true })).toBeVisible();

  const reviewer = agents.locator("details").filter({ hasText: "reviewer" });
  await reviewer.locator("summary").click();
  await reviewer.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("updates 1 Team references");
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(agents.getByText("reviewer", { exact: true })).toHaveCount(0);

  const review = teams.locator("details").filter({ hasText: "review" });
  await review.locator("summary").click();
  await review.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("removes 1 graph components");
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.locator('.react-flow__node[data-id="teamCall"]')).toHaveCount(0);
});

test("Runtime Settings exposes host policy and an exact restart command for denied requirements", async ({ page }) => {
  const spec = {
    ...emptySpec,
    components: [{ id: "docs", type: "context", config: { source: "file", path: "docs/guide.md" } }],
    entrypoint: "docs",
    runtime: { modules: ["./runtime.mjs"] },
  };
  await page.route("**/api/spec", (route) => route.fulfill({ json: {
    ...specPayload(true),
    spec,
    capabilityPolicy: { allowModules: false, allowFiles: false, contextRoots: [], processCommands: [], networkHosts: [], approvedToolIds: ["custom.review"] },
    diagnostics: [
      { code: "RUNTIME_MODULE_EXECUTION_DISABLED", path: "$.runtime.modules", message: "Modules denied", severity: "error" },
      { code: "HOST_FILE_CAPABILITY_DENIED", path: "$.components[0].config.path", message: "Files denied", severity: "error", componentId: "docs" },
    ],
  } }));
  await page.goto("/settings?section=runtime");
  await expect(page.getByRole("heading", { name: "Studio host policy" })).toBeVisible();
  await expect(page.getByText("2 saved-spec requirements are denied by this host.")).toBeVisible();
  const command = page.getByRole("alert").getByText(/harnest studio/);
  await expect(command).toContainText("harnest studio e2e.yaml --port 3100 --allow-modules --allow-files --context-root docs/guide.md --approve-tool custom.review");
  await page.getByRole("alert").getByRole("button", { name: "Copy" }).click();
  await expect(page.getByRole("alert").getByRole("button", { name: "Copied" })).toBeVisible();
});

test("subgraph deep links and mobile Inspector sheet survive browser navigation", async ({ page }) => {
  const spec = {
    ...emptySpec,
    subgraphs: {
      review: {
        components: [{ id: "review-prompt", type: "prompt", config: { template: "Review {{input}}" } }],
        connections: [],
        entrypoint: "review-prompt",
      },
    },
    studio: {
      positions: {},
      subgraphs: { review: { positions: { "review-prompt": { x: 80, y: 80 } } } },
    },
  };
  await page.route("**/api/spec", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { ...specPayload(true), spec } })
    : route.fulfill({ json: { ok: true, diagnostics: [] } }));
  await page.route("**/api/validate", (route) => route.fulfill({ json: { ok: true, diagnostics: [] } }));
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/builder");
  const openReview = async () => {
    await page.getByLabel("Open graph").click();
    await page.getByRole("option", { name: "review" }).click();
  };
  const collapsedDock = page.locator(".bottom-dock.is-collapsed");
  await expect(collapsedDock).toHaveCSS("min-height", "44px");
  expect(await collapsedDock.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(45);
  await openReview();
  await expect(page).toHaveURL(/\/builder\?graph=review$/);
  await expect(page.locator(".h-node")).toBeVisible();
  await page.reload();
  await expect(page.locator(".studio-shell")).toBeVisible();
  await expect(page.getByLabel("Open graph")).toContainText("review");
  await page.goBack();
  await expect(page).toHaveURL(/\/builder$/);
  await openReview();
  await page.locator(".h-node").click();
  const inspector = page.locator(".inspector-panel");
  await expect(inspector).toBeVisible();
  await inspector.getByRole("button", { name: "Close" }).click();
  await expect(inspector).toBeHidden();
});

test("recipe replacement warns before resetting a saved Harness", async ({ page }) => {
  const promptSpec = {
    ...emptySpec,
    components: [{ id: "prompt", type: "prompt", config: { template: "Keep {{input}}" } }],
    entrypoint: "prompt",
    studio: { positions: { prompt: { x: 80, y: 80 } } },
  };
  await page.route("**/api/spec", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { ...specPayload(true), spec: promptSpec } })
    : route.fulfill({ json: { ok: true, diagnostics: [] } }));
  await page.route("**/api/validate", (route) => route.fulfill({ json: { ok: true, diagnostics: [] } }));
  await page.goto("/builder");
  await page.getByRole("button", { name: /Add/ }).click();
  await page.getByRole("tab", { name: "Recipes" }).click();
  await page.locator(".palette-item").first().click();
  const warning = page.getByRole("alertdialog");
  await expect(warning).toContainText("tests, runtime settings, and layout");
  await warning.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".h-node")).toHaveCount(1);
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
