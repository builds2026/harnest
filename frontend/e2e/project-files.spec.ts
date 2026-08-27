import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";

const e2eBaseUrl = `http://127.0.0.1:${Number(process.env.HARNEST_E2E_PORT ?? "3100")}`;
const spec = {
  version: "0.2",
  components: [{ id: "prompt", type: "prompt", config: { template: "{{input}}" } }],
  connections: [],
  entrypoint: "prompt",
  tests: [],
  studio: { positions: { prompt: { x: 80, y: 80 } } },
};

test("Project dock previews read-only metadata without exposing mutations", async ({ page }) => {
  const readOnlyFiles = [
    { path: ".harnest/project.json", size: 48, sha256: "0".repeat(64), previewable: true, editable: false, content: "{\n  \"version\": 1\n}\n" },
    { path: ".harnest/studio.json", size: 32, sha256: "1".repeat(64), previewable: true, editable: false, content: "{\n  \"positions\": {}\n}\n" },
  ];
  const mutations: string[] = [];
  await page.context().addCookies([{ name: "harnest.studio.locale", value: "en-US", url: e2eBaseUrl }]);
  await page.route("**/api/spec", (route) => route.fulfill({ json: { spec, yaml: "version: '0.2'\n", file: "harnest.yaml", exists: true, diagnostics: [] } }));
  await page.route("**/api/validate", (route) => route.fulfill({ json: { ok: true, diagnostics: [] } }));
  await page.route("**/api/catalog", (route) => route.fulfill({ json: { components: [], tools: [], skills: [], templates: [], connectionTypes: [], warnings: [] } }));
  await page.route("**/api/connections", (route) => route.fulfill({ json: { connections: [] } }));
  await page.route(/\/api\/project(?:\?.*)?$/, (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      mutations.push(request.method());
      return route.fulfill({ status: 405, json: { error: { message: "Read only" } } });
    }
    const path = new URL(request.url()).searchParams.get("path");
    if (!path) return route.fulfill({ json: {
      project: { root: "cli-project", harness: "harnest.yaml", managed: false },
      files: readOnlyFiles.map(({ content: _content, ...file }) => file),
    } });
    const file = readOnlyFiles.find((candidate) => candidate.path === path)!;
    return route.fulfill({ json: { file } });
  });

  await page.goto("/builder");
  await page.getByRole("tab", { name: "Project" }).click();
  const projectDock = page.locator("#dock-panel-project");
  for (const file of readOnlyFiles) {
    const row = projectDock.getByRole("button", { name: new RegExp(file.path.split("/").at(-1)!.replace(".", "\\.")) });
    await expect(row).toBeEnabled();
    await row.click();
    const preview = projectDock.getByLabel(file.path);
    await expect(preview).toHaveValue(file.content);
    await expect(preview).toHaveAttribute("readonly", "");
  }
  await expect(projectDock.getByText("Read only", { exact: true })).toBeVisible();
  await expect(projectDock.getByText("Preview only. Project metadata is managed by Harnest and cannot be edited, saved, or deleted here.")).toBeVisible();
  await expect(projectDock.getByRole("button", { name: "Delete source" })).toBeDisabled();
  await expect(projectDock.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  expect(mutations).toHaveLength(0);
});

test("Project dock opens, edits, saves, creates, deletes, and imports a managed folder copy", async ({ page }) => {
  const importRoot = await mkdtemp(join(tmpdir(), "harnest-project-e2e-"));
  await mkdir(join(importRoot, "node_modules"));
  await writeFile(join(importRoot, "harnest.yaml"), "version: '0.2'\ncomponents: []\nconnections: []\nentrypoint: ''\n");
  await writeFile(join(importRoot, ".env"), "SECRET=excluded\n");
  await writeFile(join(importRoot, "node_modules", "ignored.js"), "ignored\n");
  try {
    await page.context().addCookies([{ name: "harnest.studio.locale", value: "en-US", url: e2eBaseUrl }]);
    await page.route("**/api/spec", (route) => route.fulfill({ json: {
      spec,
      yaml: 'version: "0.2"\ncomponents:\n  - id: prompt\n    type: prompt\n    config:\n      template: "{{input}}"\nconnections: []\nentrypoint: prompt\n',
      file: "harnest.yaml", exists: true, diagnostics: [],
    } }));
    await page.route("**/api/validate", (route) => route.fulfill({ json: { ok: true, diagnostics: [] } }));
    await page.route("**/api/catalog", (route) => route.fulfill({ json: { components: [], tools: [], skills: [], templates: [], connectionTypes: [], warnings: [] } }));
    await page.route("**/api/connections", (route) => route.fulfill({ json: { connections: [] } }));

    let managed = false;
    let projectName = "cli-project";
    let files = [{ path: ".harnest/prompts/main.md", size: 10, sha256: "a".repeat(64), previewable: true, editable: true }];
    const contents = new Map([[files[0]!.path, "Hello {{input}}\n"]]);
    const mutations: Array<Record<string, unknown>> = [];
    await page.route(/\/api\/project(?:\?.*)?$/, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "GET" && url.searchParams.has("path")) {
        const path = url.searchParams.get("path")!;
        const file = files.find((candidate) => candidate.path === path)!;
        return route.fulfill({ json: { file: { ...file, content: contents.get(path) } } });
      }
      if (request.method() === "GET") return route.fulfill({ json: {
        project: { root: projectName, harness: "harnest.yaml", managed }, files,
      } });
      const body = request.postDataJSON() as Record<string, unknown>;
      mutations.push(body);
      if (request.method() === "POST") {
        const path = String(body.path);
        const file = { path, size: String(body.content).length, sha256: "b".repeat(64), previewable: true, editable: true };
        files = [...files, file];
        contents.set(path, String(body.content));
        return route.fulfill({ status: 201, json: { file: { ...file, content: contents.get(path) } } });
      }
      if (request.method() === "PUT") {
        const path = String(body.path);
        const content = String(body.content);
        const file = { path, size: content.length, sha256: "c".repeat(64), previewable: true, editable: true };
        files = files.map((candidate) => candidate.path === path ? file : candidate);
        contents.set(path, content);
        return route.fulfill({ json: { file: { ...file, content } } });
      }
      const path = String(body.path);
      files = files.filter((candidate) => candidate.path !== path);
      contents.delete(path);
      return route.fulfill({ json: { ok: true } });
    });
    await page.route("**/api/project/import", async (route) => {
      managed = true;
      projectName = "managed-copy";
      files = [];
      await route.fulfill({ status: 201, json: { project: { name: basename(importRoot), managed: true, fileCount: 1, excludedCount: 0, bytes: 64 } } });
    });

    await page.goto("/builder");
    await page.getByRole("tab", { name: "Project" }).click();
    const projectDock = page.locator("#dock-panel-project");
    await expect(projectDock.getByText("Current project")).toBeVisible();
    await expect(projectDock.getByText("CLI project", { exact: true })).toBeVisible();

    await projectDock.getByRole("button", { name: /prompts\/main\.md/ }).click();
    const editor = projectDock.getByLabel(".harnest/prompts/main.md");
    await expect(editor).toHaveValue("Hello {{input}}\n");
    await editor.fill("Updated {{input}}\n");
    await expect(projectDock.getByText("Save or discard the open source")).toBeVisible();
    await projectDock.getByRole("button", { name: "Save", exact: true }).click();
    await expect(projectDock.getByText("Project source saved")).toBeVisible();
    expect(mutations.at(-1)).toMatchObject({ path: ".harnest/prompts/main.md", content: "Updated {{input}}\n" });

    await projectDock.getByRole("button", { name: "New source" }).click();
    const createDialog = page.getByRole("dialog", { name: "Create project source" });
    await createDialog.getByLabel("Source type").click();
    await page.getByRole("option", { name: /Context/ }).click();
    await createDialog.getByLabel("Source name").fill("brief");
    await createDialog.getByRole("button", { name: "Create" }).click();
    await expect(projectDock.getByLabel(".harnest/context/brief.md")).toBeVisible();
    expect(mutations.at(-1)).toMatchObject({ action: "create", path: ".harnest/context/brief.md" });

    await projectDock.getByLabel(".harnest/context/brief.md").fill("Ground truth\n");
    await projectDock.getByRole("button", { name: "Save", exact: true }).click();
    await projectDock.getByRole("button", { name: "Delete source" }).click();
    const deleteDialog = page.getByRole("alertdialog");
    await expect(deleteDialog).toContainText("Permanently delete .harnest/context/brief.md");
    await deleteDialog.getByRole("button", { name: "Delete source" }).click();
    await expect(projectDock.getByText("Deleted .harnest/context/brief.md")).toBeVisible();

    await expect(projectDock.getByRole("button", { name: "Open folder copy…" })).toBeVisible();
    await page.locator('input[type="file"][webkitdirectory]').setInputFiles(importRoot);
    const importDialog = page.getByRole("dialog", { name: "Open folder as a managed copy" });
    await expect(importDialog).toContainText("1 files ready to validate");
    await expect(importDialog).toContainText("2 excluded");
    await importDialog.getByRole("button", { name: "Open managed copy" }).click();
    await expect(page).toHaveURL(/\/builder$/);
    await page.getByRole("tab", { name: "Project" }).click();
    const managedDock = page.locator("#dock-panel-project");
    await expect(managedDock.getByText("Managed Studio copy", { exact: true })).toBeVisible();
    await expect(managedDock.getByText(`Opened ${basename(importRoot)}: 1 files copied, 2 excluded.`)).toBeVisible();
  } finally {
    await rm(importRoot, { recursive: true, force: true });
  }
});
