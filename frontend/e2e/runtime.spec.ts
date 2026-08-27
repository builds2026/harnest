import { expect, test, type Page } from "@playwright/test";

const baseURL = `http://127.0.0.1:${process.env.HARNEST_RUNTIME_E2E_PORT ?? "3200"}`;

const send = async (page: Page, message: string) => {
  await page.getByLabel("Message the harness").fill(message);
  await page.getByRole("button", { name: "Send request" }).click();
};

const permissionDialog = (page: Page) => page.getByRole("alertdialog", { name: "Tool permission" });

test("real Playground keeps scoped permissions and reuses an uploaded file", async ({ page }) => {
  await page.context().addCookies([{
    name: "harnest.studio.locale",
    value: "en-US",
    url: baseURL,
  }]);
  await page.goto("/playground");
  await expect(page.getByLabel("Message the harness")).toBeEnabled();
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page.getByLabel("Message the harness")).toBeEnabled();

  const existing = await page.request.get("/api/tool-permissions").then((response) => response.json()) as {
    permissions: Array<{ toolId: string; connectionId?: string; capability?: string; resource?: string }>;
  };
  for (const permission of existing.permissions.filter(({ toolId }) => toolId === "lookup-city")) {
    await page.request.delete("/api/tool-permissions", {
      headers: { origin: baseURL },
      data: permission,
    });
  }

  await send(page, "deny this call");
  await expect(permissionDialog(page)).toBeVisible();
  await permissionDialog(page).getByRole("button", { name: "Deny" }).click();
  await expect(page.getByText(/Run failed:.*denied/iu).last()).toBeVisible();

  await send(page, "allow this call once");
  await expect(permissionDialog(page)).toBeVisible();
  await permissionDialog(page).getByRole("button", { name: "Allow once" }).click();
  await expect(page.getByText(/runtime-ok tool=South Korea media=0/).last()).toBeVisible();

  await send(page, "ask again after once");
  await expect(permissionDialog(page)).toBeVisible();
  await permissionDialog(page).getByRole("button", { name: "Allow for this run" }).click();
  await expect(page.getByText(/runtime-ok tool=South Korea media=0/).last()).toBeVisible();

  await send(page, "run-only permission should ask again");
  await expect(permissionDialog(page)).toBeVisible();
  await permissionDialog(page).getByRole("button", { name: "Always allow" }).click();
  await expect(page.getByText(/runtime-ok tool=South Korea media=0/).last()).toBeVisible();

  await send(page, "always should skip the prompt");
  await expect(page.getByText(/runtime-ok tool=South Korea media=0/).last()).toBeVisible();
  await expect(permissionDialog(page)).toHaveCount(0);

  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await page.locator('input[type="file"]').first().setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: pixel });
  await expect(page.getByText("pixel.png").first()).toBeVisible();
  await send(page, "read the selected image");
  await expect(page.getByText(/runtime-ok tool=South Korea media=1:image\/png/).last()).toBeVisible();

  await page.reload();
  await expect(page.getByText("pixel.png").first()).toBeVisible();
  await send(page, "read the same image again");
  await expect(page.getByText(/runtime-ok tool=South Korea media=1:image\/png/).last()).toBeVisible();

  await page.goto("/settings?section=tools");
  const permission = page.locator("article", { hasText: "lookup-city" });
  await expect(permission).toContainText("network");
  await permission.getByRole("button", { name: "Revoke" }).click();
  await expect(permission).toHaveCount(0);

  await page.goto("/playground");
  await send(page, "permission was revoked");
  await expect(permissionDialog(page)).toBeVisible();
  await permissionDialog(page).getByRole("button", { name: "Deny" }).click();
});
