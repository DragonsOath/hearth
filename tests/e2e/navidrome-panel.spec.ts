import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Navidrome's panel against the stand-in Navidrome (port 4533, answering as a real 0.64.2 did):
// songs, who is listening, the scan and a missing file, and a user made an administrator through
// the real plan, approval and read-back code. The password never reaches the page.

const OWNER_PASSWORD = "e2e owner password";
const PASSWORD = "e2e-navidrome-pass";

let hosts = (Date.now() + 67_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.87`;
};

async function addNavidrome(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Navidrome ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:4533`,
      category: "Media",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Navidrome ${run} login`,
      kind: "login",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      username: "admin",
      value: PASSWORD,
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

async function approve(page: Page, says: RegExp) {
  const pop = page.getByTestId("approve-here");
  await expect(pop).toBeVisible({ timeout: 15_000 });
  await expect(pop).toContainText(says);
  await pop.getByTestId("approve-here-approve").click();
  const confirm = pop.getByTestId("approve-confirm");
  const done = pop.getByText(/^done$/i);
  await expect(confirm.or(done).first()).toBeVisible({ timeout: 30_000 });
  if (await confirm.isVisible()) {
    await confirm.getByPlaceholder("Password").fill(OWNER_PASSWORD);
    await confirm.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(done).toBeVisible({ timeout: 30_000 });
  }
  await pop.getByTestId("approve-here-close").click();
}

const shot = (page: Page, name: string) =>
  page.screenshot({
    path: `test-results/screens/${test.info().project.name === "mobile" ? "mobile" : "desktop"}/${name}.png`,
  });

test.describe("Navidrome's panel", () => {
  let id = "";
  test.beforeEach(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addNavidrome(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Overview: songs, listening now, scan and missing files", async ({ page }) => {
    const panel = await open(page, id, "overview");
    const d = panel.getByTestId("nd-dashboard");
    await expect(d).toBeVisible({ timeout: 30_000 });
    await expect(d.getByTestId("nd-songs")).toHaveText("1,284");
    await expect(d.getByTestId("nd-listening")).toHaveText("1");
    await expect(d.getByTestId("nd-missing")).toHaveText("1");
    await expect(d.getByTestId("nd-now")).toContainText("Tide");
    await expect(d.getByTestId("nd-now")).toContainText("sam on Sam's phone");
    await expect(d.getByTestId("nd-missing-list")).toContainText(
      "Lantern/First Light/02 Ember.mp3",
    );
    await expect(page.locator("body")).not.toContainText("e2e-SECRET");
    await shot(page, "navidrome-overview");
    await d.getByTestId("nd-forget").click();
    await approve(page, /Forget the file Navidrome .* can no longer find/);
    await expect(d.getByTestId("nd-missing")).toHaveText("0", { timeout: 20_000 });
  });

  // Own music (11-12, the owner: "if I owned my own music and was using Plexamp"): Ember makes
  // the playlist in the server that holds the music, the same flow as YouTube Music.
  test("Have Ember make a playlist from the music Navidrome holds", async ({ page }) => {
    const panel = await open(page, id, "overview");
    const d = panel.getByTestId("nd-dashboard");
    await expect(d).toBeVisible({ timeout: 30_000 });
    await d.getByTestId("make-playlist").click();
    const form = d.getByTestId("make-playlist-form");
    await expect(form.getByTestId("make-playlist-go")).toBeDisabled();
    await expect(form.getByTestId("ember-mark")).toBeVisible();
    await form.getByTestId("make-playlist-what").fill("quiet songs for a rainy evening");
    await form.getByLabel("About how many songs").fill("30");
    await shot(page, "navidrome-make-playlist");
    await form.getByTestId("make-playlist-go").click();
    await expect(form).toHaveCount(0);
    if (test.info().project.name === "mobile")
      await page.getByRole("button", { name: "Show Ember" }).click();
    await expect(
      page
        .getByText(/Make me a playlist in .* \(Navidrome service .*from my own music: quiet songs/)
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test("People: make a user an administrator through a plan", async ({ page }) => {
    const panel = await open(page, id, "people");
    const tab = panel.getByTestId("nd-people-tab");
    await expect(tab.getByTestId("nd-user")).toHaveCount(3, { timeout: 30_000 });
    const sam = tab.getByTestId("nd-user").filter({ hasText: "sam" });
    await expect(sam).toContainText("listening to Tide");
    await expect(sam).toContainText("Listens with Symfonium");
    await shot(page, "navidrome-people");
    await sam.getByTestId("nd-admin-toggle").click();
    await approve(page, /Make Sam an administrator/);
    await expect(sam).toContainText("administrator", { timeout: 20_000 });
  });
});
