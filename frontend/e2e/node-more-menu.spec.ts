import { expect, test, type Page } from "@playwright/test";

const baseUrl = `http://127.0.0.1:${Number(process.env.HARNEST_E2E_PORT ?? "3100")}`;

async function openBuilder(page: Page, version: "0.2" | "0.3", onSave?: (yaml: string) => void) {
  const spec = {
    version,
    components: [{ id: "prompt", type: "prompt", config: { template: "{{input}}" } }],
    connections: [],
    entrypoint: "prompt",
    tests: [],
    studio: { positions: { prompt: { x: 80, y: 80 } } },
  };
  await page.context().addCookies([{ name: "harnest.studio.locale", value: "en-US", url: baseUrl }]);
  await page.route("**/api/spec", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { spec, yaml: `version: "${version}"\n`, file: "node-menu.yaml", exists: true, diagnostics: [] } });
    } else {
      onSave?.((route.request().postDataJSON() as { yaml: string }).yaml);
      await route.fulfill({ json: { ok: true, diagnostics: [] } });
    }
  });
  await page.route("**/api/validate", (route) => route.fulfill({ json: { ok: true, diagnostics: [] } }));
  await page.route("**/api/connections", (route) => route.fulfill({ json: { connections: [] } }));
  await page.goto("/builder");
  await expect(page.locator('.react-flow__node[data-id="prompt"]')).toBeVisible();
}

test("node More menu supports keyboard configure, rename, pin, and confirmed delete", async ({ page }) => {
  await openBuilder(page, "0.3");
  const node = page.locator('.react-flow__node[data-id="prompt"]');
  const more = node.getByRole("button", { name: "Manage prompt" });

  await more.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Manage prompt");
  await more.focus();
  await page.keyboard.press("Enter");
  const configure = page.getByRole("menuitem", { name: "Component settings" });
  await expect(configure).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Component ID")).toBeVisible();

  await more.click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const componentId = page.getByLabel("Component ID");
  await expect(componentId).toBeFocused();

  await more.click();
  await page.getByRole("menuitem", { name: "Pin position" }).click();
  await expect(node.getByLabel("Pinned position")).toBeVisible();
  await more.click();
  await expect(page.getByRole("menuitem", { name: "Unpin position" })).toBeVisible();
  await page.keyboard.press("Escape");

  await more.click();
  await page.getByRole("menuitem", { name: "Delete component" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("prompt");
  await expect(node).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(node).toBeVisible();

  await more.click();
  await page.getByRole("menuitem", { name: "Delete component" }).click();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(node).toHaveCount(0);
});

test("v0.2 keeps node actions without exposing v0.3 pinning", async ({ page }) => {
  let savedYaml = "";
  await openBuilder(page, "0.2", (yaml) => { savedYaml = yaml; });
  await page.getByRole("button", { name: "Manage prompt" }).click();
  await expect(page.getByRole("menuitem", { name: "Pin position" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByLabel("Component ID").fill("request");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.locator('.react-flow__node[data-id="request"]')).toBeVisible();
  await expect.poll(() => savedYaml).toMatch(/version:\s+["']?0\.2/);
  expect(savedYaml).not.toMatch(/version:\s+["']?0\.3/);
});
