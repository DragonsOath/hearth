import { expect, test } from "@playwright/test";
// The owner password the claim step sets (claim.setup.ts).
const OWNER_PASSWORD = "e2e owner password";

// PCs and devices (docs/design/ONE_ACCOUNT.md): Add a device signs another browser in with a
// one-time code, and Remove signs it out again.

test("Add a device: a code signs another browser in once; removing it signs it out", async ({
  page,
  browser,
  baseURL,
}) => {
  // Making a code is a sensitive step: prove it is you first (as the page would ask).
  expect(
    (await page.request.post("/api/auth/login", { data: { password: OWNER_PASSWORD } })).status(),
  ).toBe(204);
  await page.goto("/devices");
  await expect(page.getByRole("heading", { name: "PCs and devices" })).toBeVisible();
  await page.getByRole("button", { name: "Show a QR code" }).click();
  const code = (await page.getByTestId("device-code").textContent())!.trim();
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  // The other device: a fresh browser with nobody signed in, opening the link the QR holds.
  const other = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const tablet = await other.newPage();
  await tablet.goto(`${baseURL}/pair?code=${code}`);
  await expect(tablet).toHaveURL(new RegExp(`${baseURL}/?$`));
  expect((await tablet.request.get("/api/workspace")).status()).toBe(200);

  // It shows on your page, signed in with a code; Sign out removes it.
  await expect(page.getByTestId("add-device")).toContainText("Signed in:");
  const row = page.getByTestId("devices").locator("li", { hasText: "a code from Add a device" });
  await row.getByRole("button", { name: "Sign out" }).click();
  await expect(row).toHaveCount(0);
  expect((await tablet.request.get("/api/workspace")).status()).toBe(401);

  // The same code does not work twice.
  const again = await (
    await browser.newContext({ storageState: { cookies: [], origins: [] } })
  ).newPage();
  await again.goto(`${baseURL}/pair?code=${code}`);
  await expect(again.getByRole("alert")).toContainText("already used");
  await other.close();
});

test("this PC's icon and name: the name shows under the icon in its color", async ({
  page,
}, testInfo) => {
  await page.goto("/devices");
  const list = page.getByTestId("pc-list");
  await expect(list).toBeVisible();
  await page.getByRole("button", { name: "Choose an icon" }).click();
  const editor = page.getByTestId("pc-editor");
  await editor.getByTestId("pc-name").fill("Homeserver");
  await editor.getByRole("radio", { name: "Mountain" }).click();
  await editor.getByRole("button", { name: "Save" }).click();
  const name = list.getByTestId("pc-name-label").first();
  await expect(name).toHaveText("Homeserver");
  await expect(name).toHaveCSS("color", "rgb(61, 155, 255)");
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/pcs-and-devices.png`,
    fullPage: true,
  });
});

test("copy another Hearth's layout: read with its key, see what changes, copy, undo", async ({
  page,
  baseURL,
}) => {
  // The other Hearth here is this one, reached by its address like any other: the same path.
  expect(
    (await page.request.post("/api/auth/login", { data: { password: OWNER_PASSWORD } })).status(),
  ).toBe(204);
  await page.request.post("/api/desk/layouts", {
    data: { name: "Movie night", panels: "tool:storage,tool:todo" },
  });
  await page.goto("/vault");
  const vaultKey = page.getByTestId("hearth-key");
  await vaultKey.getByRole("button", { name: "Show" }).click();
  const key = (await vaultKey.getByTestId("hearth-key-value").textContent())!.trim();

  await page.goto("/devices");
  await page.getByTestId("layout-copy-start").click();
  const form = page.getByTestId("layout-copy");
  await form.getByTestId("layout-hub").fill(new URL(baseURL!).host);
  await form.getByTestId("layout-key").fill("hearth_notTheRightKey1234");
  await form.getByTestId("layout-preview-go").click();
  await expect(form.getByRole("alert")).toContainText("not right");
  await form.getByTestId("layout-key").fill(key);
  await form.getByTestId("layout-preview-go").click();
  await expect(form.getByTestId("layout-preview")).toContainText("Movie night");
  await form.getByTestId("layout-copy-go").click();
  const done = page.getByTestId("layout-copied");
  await expect(done).toContainText("layout");
  await page.screenshot({ path: "test-results/screens/desktop/layout-copy.png", fullPage: true });
  await done.getByRole("button", { name: "Undo" }).click();
  await page.waitForLoadState();
  const layouts = (await (await page.request.get("/api/desk/layouts")).json()) as {
    name: string;
  }[];
  expect(layouts.map((l) => l.name)).toContain("Movie night");
});
