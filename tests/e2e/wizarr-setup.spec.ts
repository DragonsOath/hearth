import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Wizarr's Wizard and Settings tabs against the stand-in Wizarr (port 5690): its admin sign-in is
// added in the panel, then invite steps and General settings change through the real plan,
// confirmation, and read-back code.

let hosts = (Date.now() + 7_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.12`;
};

async function addWizarr(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Wizarr ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:5690`,
      category: "Media",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Wizarr ${run} key`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-wizarr-setup-key",
    },
  });
  return id;
}

async function open(page: Page, id: string, tab: string) {
  await page.goto(`/?panels=${encodeURIComponent(`service:${id}@${tab}`)}`);
  const panel =
    test.info().project.name === "mobile"
      ? page.getByTestId("service-workspace")
      : page.locator(`[data-panel="service:${id}"]`);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  return panel;
}

async function confirm(page: Page, expectPlan: RegExp, expectDone: RegExp) {
  const pop = page.getByTestId("approve-here");
  await expect(pop).toBeVisible({ timeout: 15_000 });
  await expect(pop).toContainText(expectPlan);
  await pop.getByTestId("approve-here-approve").click();
  await expect(pop).toContainText(expectDone, { timeout: 20_000 });
  await pop.getByTestId("approve-here-close").click();
}

const shot = (page: Page, name: string) =>
  page.screenshot({
    path: `test-results/screens/${test.info().project.name === "mobile" ? "mobile" : "desktop"}/${name}.png`,
  });

test.describe("Wizarr's Settings tab: General and Wizard", () => {
  let id = "";
  test.beforeAll(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addWizarr(request, `setup ${info.project.name}${Date.now() % 100000}`);
  });

  test("connect the admin sign-in, then add, edit and move invite steps", async ({ page }) => {
    const panel = await open(page, id, "config/wizard");
    const signIn = panel.getByTestId("wizarr-admin-signin");
    await expect(signIn).toContainText("admin sign-in");
    // A wrong password is refused, and the form stays for another try.
    await signIn.getByTestId("wizarr-admin-username").fill("admin");
    await signIn.getByTestId("wizarr-admin-password").fill("e2e-wizarr-admin");
    await signIn.getByTestId("wizarr-admin-save").click();

    const plex = panel.getByTestId("wizarr-wizard-plex");
    await expect(plex).toBeVisible({ timeout: 15_000 });
    const before = panel.getByTestId("wizarr-steps-plex-pre_invite");
    const after = panel.getByTestId("wizarr-steps-plex-post_invite");
    await expect(before).toContainText("Welcome");
    await expect(after).toContainText("Get the app");
    await expect(after).toContainText("Needs a click");
    // Wizarr's own guide, as its Preview Wizard button opens it; each step opens at its place.
    await expect(panel.getByTestId("wizarr-preview-plex")).toHaveAttribute(
      "href",
      /\/wizard\/plex\/0$/,
    );
    await expect(panel.getByTestId("wizarr-step-preview-1")).toHaveAttribute(
      "href",
      /\/wizard\/plex\/0$/,
    );
    await expect(panel.getByTestId("wizarr-step-preview-2")).toHaveAttribute(
      "href",
      /\/wizard\/plex\/1$/,
    );
    await expect(panel.getByTestId("wizarr-step-preview-3")).toHaveAttribute(
      "href",
      /\/wizard\/plex\/2$/,
    );
    await shot(page, "wizarr-wizard");

    // Add a step at the end of "After they accept".
    await panel.getByTestId("wizarr-step-add-plex-post_invite").click();
    const editor = panel.getByTestId("wizarr-step-editor");
    await editor.getByTestId("wizarr-step-title").fill("Ask for movies");
    await editor.getByTestId("wizarr-step-text").fill("# Ask for movies\n\nUse Seerr to ask.");
    await shot(page, "wizarr-step-editor");
    await editor.getByTestId("wizarr-step-save").click();
    await expect(page.getByTestId("approve-here")).toBeVisible({ timeout: 15_000 });
    await shot(page, "wizarr-approve");
    await confirm(page, /Add a Plex step: Ask for movies/, /read back/);
    await expect(after).toContainText("Ask for movies");

    // Edit the first step's title.
    await panel.getByTestId("wizarr-step-edit-1").click();
    await panel.getByTestId("wizarr-step-title").fill("Welcome to Family Media");
    await panel.getByTestId("wizarr-step-save").click();
    await confirm(page, /Edit the Plex step Welcome[\s\S]*Welcome to Family Media/, /read back/);
    await expect(before).toContainText("Welcome to Family Media");

    // Move "You're in" up, to first in its list.
    await after.getByRole("button", { name: "Move You're in: Plex up" }).click();
    await confirm(page, /Move the Plex step You're in: Plex/, /read back/);
    await expect(after.locator("li").first()).toContainText("You're in: Plex");
  });

  test("Settings: change what happens when access ends", async ({ page }) => {
    const panel = await open(page, id, "config");
    // Settings opens on General; Wizard is the section next to it.
    await expect(panel.locator('[data-hearth-target="settings:general"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const expiry = panel.getByTestId("wizarr-expiry-action");
    await expect(expiry).toHaveValue("delete", { timeout: 15_000 });
    await expect(panel.getByTestId("wizarr-display-name")).toHaveValue("Family Media");
    await shot(page, "wizarr-settings");
    await expiry.selectOption("disable");
    await panel.getByTestId("wizarr-settings-save").click();
    await confirm(page, /When someone's access ends[\s\S]*Disable them/, /read back/);
    await expect(panel.getByTestId("wizarr-expiry-action")).toHaveValue("disable");
    await expect(panel.getByTestId("wizarr-clean-expired")).toContainText("Disable everyone");
  });

  test("Designs: pick Vault in Emerald, change the headline, and use it for Plex", async ({
    page,
  }) => {
    const panel = await open(page, id, "config/wizard");
    const designs = panel.getByTestId("wizarr-designs");
    await expect(designs).toBeVisible({ timeout: 15_000 });
    await designs.getByTestId("wizarr-design-open-vault").click();
    const designer = panel.getByTestId("wizarr-designer");
    await expect(designer.getByTestId("wizarr-design-server")).toHaveValue("plex");
    await designer.getByTestId("wizarr-theme-emerald").click();
    // The Plex sign-in step comes first; its welcome follows.
    await designer.getByRole("tab", { name: /After: Welcome/ }).click();
    await designer.getByTestId("wizarr-word-headline").fill("Welcome to Family Media");
    const preview = designer.getByTestId("wizarr-design-preview");
    await expect(preview).toHaveAttribute("sandbox", "");
    await expect(preview.contentFrame().locator("h1")).toHaveText("Welcome to Family Media");
    await designer.scrollIntoViewIfNeeded();
    await shot(page, "wizarr-design");

    await designer.getByTestId("wizarr-design-replace").check();
    await designer.getByTestId("wizarr-design-apply").click();
    const pop = page.getByTestId("approve-here");
    await expect(pop).toBeVisible({ timeout: 15_000 });
    await expect(pop).toContainText(
      /Delete the Plex step[\s\S]*Add a Plex step: Connect your Plex account/,
    );
    await shot(page, "wizarr-design-approve");
    await pop.getByTestId("approve-here-approve").click();
    await expect(pop).toContainText(/read back/, { timeout: 30_000 });
    await pop.getByTestId("approve-here-close").click();
    const before = panel.getByTestId("wizarr-steps-plex-pre_invite");
    const after = panel.getByTestId("wizarr-steps-plex-post_invite");
    await expect(before.locator("li")).toHaveCount(1);
    await expect(before).toContainText("Connect your Plex account");
    await expect(before).toContainText("Needs a click");
    await expect(after.locator("li")).toHaveCount(1);
    await expect(after).toContainText("Welcome to Family Media");

    // 11-04: change only the colors from a step's own edit; every word stays.
    await after.locator('[data-testid^="wizarr-step-edit-"]').click();
    const editor = panel.getByTestId("wizarr-step-editor");
    const colors = editor.getByTestId("wizarr-step-colors");
    await expect(colors.getByTestId("wizarr-theme-emerald")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await colors.getByTestId("wizarr-theme-rose").click();
    await expect(
      colors.getByTestId("wizarr-design-preview").contentFrame().locator("h1"),
    ).toHaveText("Welcome to Family Media");
    await colors.getByTestId("wizarr-design-preview").scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shot(page, "wizarr-step-colors");
    await editor.getByTestId("wizarr-step-save").click();
    // One plan recolors both Plex steps, and says which colors, not the step's styling.
    await expect(pop).toBeVisible({ timeout: 15_000 });
    await expect(pop).toContainText(/Rose colors/);
    await expect(pop).toContainText(/Colors[\s\S]*Emerald[\s\S]*Rose/);
    await expect(pop).not.toContainText("<style>");
    await shot(page, "wizarr-step-colors-approve");
    await pop.getByTestId("approve-here-approve").click();
    await expect(pop).toContainText(/read back/, { timeout: 30_000 });
    await pop.getByTestId("approve-here-close").click();
    await expect(after).toContainText("Welcome to Family Media");
    await expect(before).toContainText("Connect your Plex account");
    await expect(before).toContainText("Needs a click");

    // Choose colors and wording (still open) starts again from what is saved: its colors and words.
    await expect(designer.getByTestId("wizarr-design-update")).toBeChecked();
    await expect(designer.getByTestId("wizarr-theme-rose")).toHaveAttribute("aria-checked", "true");
    await designer.getByRole("tab", { name: /After: Welcome/ }).click();
    await expect(designer.getByTestId("wizarr-word-headline")).toHaveValue(
      "Welcome to Family Media",
    );
    await expect(designer.getByTestId("wizarr-design-apply")).toBeDisabled();
    await designer.getByTestId("wizarr-theme-ocean").click();
    await designer.getByTestId("wizarr-design-apply").click();
    await expect(pop).toBeVisible({ timeout: 15_000 });
    await expect(pop).toContainText(/Colors[\s\S]*Rose[\s\S]*Ocean/);
    await pop.getByTestId("approve-here-approve").click();
    await expect(pop).toContainText(/read back/, { timeout: 30_000 });
    await pop.getByTestId("approve-here-close").click();
    await expect(after).toContainText("Welcome to Family Media");
    await expect(before).toContainText("Needs a click");
  });
});
