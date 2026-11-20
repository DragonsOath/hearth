import { expect, test, type Locator, type Page } from "@playwright/test";

// Speaker names (11-13, the owner: "the speaker picker shows model numbers or IPs"): a speaker
// that only reports its model shows by its room; the owner renames one right in the picker
// (right-click on a desktop, a long press on a phone, or the pencil), the name sticks, and Reset
// name goes back. The stand-in Home Assistant has a Sonos that reports only "Sonos Era 100".

const SONOS = "media_player.sonos_era_100";

async function openHome(page: Page, run: string) {
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.18`;
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
  await home.locator('[data-page="media"]:visible').click();
  return { id, home };
}

const openMenu = async (home: Locator) => {
  await home.getByTestId("home-speaker-menu").click();
  const menu = home.getByTestId("home-speakers");
  await expect(menu).toBeVisible();
  return menu;
};

test("a speaker shows by its room, renames in the picker, and Reset name goes back", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const run = `${info.project.name}${Date.now() % 100000}`;
  const { id, home } = await openHome(page, run);
  try {
    let menu = await openMenu(home);
    // Its room, not its model number.
    await expect(menu.getByRole("button", { name: /^Den speaker/ })).toBeVisible();
    await expect(menu).not.toContainText("Sonos Era 100");

    // Rename it the way this device does: right-click on a desktop, a long press on a phone.
    const den = menu.getByRole("button", { name: /^Den speaker/ });
    if (info.project.name === "mobile") {
      await den.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true });
      await page.waitForTimeout(800);
      // The box opens while the finger is still down: the button is gone by the time it lifts.
    } else {
      await den.click({ button: "right" });
    }
    const box = menu.getByTestId("speaker-rename").getByRole("textbox");
    await expect(box).toBeVisible();
    await box.fill("Patio");
    await box.press("Enter");
    await expect(menu.getByRole("button", { name: /^Patio/ })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `test-results/screens/${info.project.name}/speaker-names.png` });

    // It sticks: picking it, the player says it, and so does the menu after a reload.
    await menu.getByRole("button", { name: /^Patio/ }).click();
    await expect(home.getByTestId("home-speaker-menu")).toContainText("Patio");
    await page.reload();
    await expect(home).toBeVisible({ timeout: 20_000 });
    await home.locator('[data-page="media"]:visible').click();
    menu = await openMenu(home);
    await expect(menu.getByRole("button", { name: /^Patio/ })).toBeVisible({ timeout: 15_000 });

    // The pencil (so it can be found), then Reset name: back to its own name.
    await menu.getByRole("button", { name: "Rename Patio" }).click();
    await menu.getByTestId("speaker-reset").click();
    await expect(menu.getByRole("button", { name: /^Den speaker/ })).toBeVisible({
      timeout: 15_000,
    });
    // Escape leaves a name as it was.
    await menu.getByRole("button", { name: "Rename Den speaker" }).click();
    await menu.getByTestId("speaker-rename").getByRole("textbox").fill("Nope");
    await menu.getByTestId("speaker-rename").getByRole("textbox").press("Escape");
    await expect(menu.getByRole("button", { name: /^Den speaker/ })).toBeVisible();
  } finally {
    await page.request.put("/api/home/speakers/name", { data: { entity: SONOS } });
    await page.request.post(`/api/services/${id}/remove`, { data: {} });
  }
});
