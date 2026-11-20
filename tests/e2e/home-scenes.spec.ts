import { expect, test } from "@playwright/test";

// The Scenes widget (11-05): a tap runs a scene, the pencil opens it to change; New adds one,
// and an open scene can be deleted. Saved in Home Assistant (the stand-in here).

test("scenes: change one, add one, delete one", async ({ page }, info) => {
  test.setTimeout(60_000);
  const run = `${info.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.17`;
  await page.request.post("/api/test/fake-apps", { data: { reset: true } });
  const res = await page.request.post("/api/services", {
    data: {
      name: `Home Assistant ${run}`,
      kind: "web",
      address: `http://${host}:8123`,
      category: "Home",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await page.request.post("/api/vault/secrets", {
    data: {
      name: `Home Assistant ${run} token`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-home-token",
    },
  });
  await page.goto(`/?panels=${encodeURIComponent(`service:${id}@home`)}`);
  const home = page.getByTestId("home-dashboard");
  await expect(home).toBeVisible({ timeout: 20_000 });

  const scenes = home.locator('[data-testid="home-scenes"]:visible').first();
  const tile = (name: string) => scenes.getByTestId("home-scene-tile").filter({ hasText: name });
  await expect(tile("Goodnight")).toBeVisible();

  // Change one: its devices open, a light gets dimmer, the name changes.
  await tile("Goodnight").getByTestId("home-scene-edit").click();
  const win = page.getByTestId("home-scene-window");
  await expect(win.getByTestId("home-scene-device")).toHaveCount(2);
  await expect(win.getByText("Brightness 50%")).toBeVisible();
  await win.getByLabel("Kitchen brightness").fill("30");
  await expect(win.getByText("Brightness 30%")).toBeVisible();
  await win.getByTestId("home-scene-name").fill("Good night");
  await page.screenshot({ path: `test-results/screens/${info.project.name}/home-scene-edit.png` });
  await win.getByTestId("home-scene-save").click();
  await expect(win).toBeHidden();
  await expect(tile("Good night")).toBeVisible();

  // A step it doesn't edit is kept.
  await tile("Leaving home").getByTestId("home-scene-edit").click();
  await expect(win.getByText("Kept as it is").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(win).toBeHidden();

  // Add one.
  await scenes.getByTestId("home-scene-new").click();
  await win.getByTestId("home-scene-name").fill("Reading time");
  await win.getByTestId("home-scene-add").selectOption("light.living_room");
  await expect(win.getByTestId("home-scene-device")).toHaveCount(1);
  await win.getByTestId("home-scene-save").click();
  await expect(win).toBeHidden();
  await expect(tile("Reading time")).toBeVisible();

  // Delete it (asks first, in the window).
  await tile("Reading time").getByTestId("home-scene-edit").click();
  await win.getByTestId("home-scene-delete").click();
  await win.getByTestId("home-scene-delete-yes").click();
  await expect(win).toBeHidden();
  await expect(tile("Reading time")).toHaveCount(0);
});
