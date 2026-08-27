import { expect, test } from "@playwright/test";

const e2ePort = Number(process.env.HARNEST_E2E_PORT ?? "3100");
const localTool = {
  manifestVersion: "1", id: "custom.argv", label: "Exact argv", description: "Preserves argument boundaries.",
  category: "Custom", risk: "destructive", kind: "local-command", source: "custom",
  connectionKinds: ["local-runtime"], inputSchema: { type: "object", additionalProperties: true },
  command: "node", args: ["--title", "two words"], cwd: ".", stdin: "json", output: "json",
};

test("Custom Tool Manager edits exact argv and confirms deletion without a Connection", async ({ page }) => {
  await page.context().addCookies([{ name: "harnest.studio.locale", value: "en-US", url: `http://127.0.0.1:${e2ePort}` }]);
  await page.route("**/api/spec", (route) => route.fulfill({ json: {
    spec: { version: "0.2", components: [], connections: [], entrypoint: "", tests: [], studio: { positions: {} } },
    yaml: 'version: "0.2"\ncomponents: []\nconnections: []\nentrypoint: ""\n', file: "e2e.yaml", exists: true, diagnostics: [],
  } }));
  await page.route("**/api/validate", (route) => route.fulfill({ json: { ok: true, diagnostics: [] } }));
  await page.route("**/api/catalog", (route) => route.fulfill({ json: { components: [], tools: [], skills: [], templates: [], connectionTypes: [], warnings: [] } }));
  await page.route("**/api/connections", (route) => route.fulfill({ json: { connections: [] } }));
  let tools = [localTool];
  let saved: Record<string, unknown> | undefined;
  let deleted = "";
  await page.route("**/api/tools", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { tools, warnings: [] } });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (route.request().method() === "DELETE") {
      deleted = String(body.id);
      tools = tools.filter(({ id }) => id !== deleted);
      return route.fulfill({ status: 204 });
    }
    saved = body;
    tools = [body.manifest as typeof localTool];
    return route.fulfill({ status: 201, json: { tool: body.manifest } });
  });

  await page.goto("/settings?section=tools");
  await page.getByRole("button", { name: "Manage tools" }).click();
  const toolDialog = page.getByRole("dialog", { name: "Custom tools" });
  await expect(toolDialog.getByText("Exact argv")).toBeVisible();
  await toolDialog.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByLabel("Test connection")).toHaveValue("");
  await page.getByLabel("Arguments 2").fill("three exact words");
  await page.getByRole("button", { name: "Add argument" }).click();
  await page.getByLabel("Arguments 3").fill("");
  await page.getByRole("button", { name: "Save tool" }).click();
  await expect.poll(() => saved).toBeTruthy();
  expect(saved).toMatchObject({ action: "save", manifest: { id: "custom.argv", args: ["--title", "three exact words", ""] } });
  expect(saved).not.toHaveProperty("connectionId");

  await expect(toolDialog.getByText("Exact argv")).toBeVisible();
  await toolDialog.getByRole("button", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("custom.argv");
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => deleted).toBe("custom.argv");
  await expect(toolDialog.getByText("No custom tools installed")).toBeVisible();

  await toolDialog.getByRole("button", { name: "Close custom tool" }).click();
  await page.goto("/settings?section=connections");
  await page.getByRole("button", { name: "Manage services" }).click();
  await page.getByRole("button", { name: "Add service" }).first().click();
  await page.getByRole("button", { name: /^MCP server/ }).first().click();
  await page.getByLabel("Sign-in method").selectOption("token");
  await expect(page.getByLabel("Bearer token")).toBeVisible();
  await page.getByLabel("Sign-in method").selectOption("none");
  await expect(page.getByLabel("Bearer token")).toHaveCount(0);
  await expect(page.getByText("Use the MCP server without credentials.")).toBeVisible();
});
