import { expect, test } from "@playwright/test";

// Editing a project from anywhere it shows (the owner, 2026-11-02): Home's cards (a pencil, or
// right-click) and a Lair project's tab in the War Room (right-click), as War Room tabs already did.

test("Home's project cards edit: a Lair card's pencil and a War Room card's right-click", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const stamp = `${testInfo.project.name} ${Date.now() % 100000}`;
  const lair = (await (
    await page.request.post("/api/projects", {
      data: { name: `Sort photos ${stamp}`, summary: "Tidy the albums", phase: "in-progress" },
    })
  ).json()) as { id: string };
  const war = (await (
    await page.request.post("/api/engine/projects", {
      data: { name: `Quest log ${stamp}`, description: "A small app." },
    })
  ).json()) as { slug: string };
  try {
    await page.goto("/");
    const card = page.getByTestId("project-card").filter({ hasText: `Sort photos ${stamp}` });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.hover();
    await page.getByRole("button", { name: `Edit Sort photos ${stamp}` }).click();
    const dialog = page.getByTestId("edit-project-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Project Name").fill(`Sort family photos ${stamp}`);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByTestId("project-card").filter({ hasText: `Sort family photos ${stamp}` }),
    ).toBeVisible();
    // Editing does not open the project.
    await expect(page).toHaveURL(/\/$/);

    const warCard = page
      .getByTestId("war-room-project-card")
      .filter({ hasText: `Quest log ${stamp}` });
    await expect(warCard).toBeVisible();
    await warCard.click({ button: "right" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Project Name")).toHaveValue(`Quest log ${stamp}`);
    await dialog.getByLabel("Project Description").fill("A small app for game night.");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(warCard).toContainText("A small app for game night.");
  } finally {
    await page.request.delete(`/api/engine/projects/${war.slug}`);
  }
  expect(lair.id).toBeTruthy();
});

test("a Lair project's tab in the War Room edits on right-click", async ({ page }, testInfo) => {
  const stamp = `${testInfo.project.name} ${Date.now() % 100000}`;
  const lair = (await (
    await page.request.post("/api/projects", {
      data: { name: `Renaming files ${stamp}`, summary: "Match the library" },
    })
  ).json()) as { id: string };
  await page.goto("/war-room");
  await page.evaluate((id) => {
    localStorage.setItem("ember.lairTabs", JSON.stringify([id]));
    localStorage.setItem("ember.lair", "main");
  }, lair.id);
  await page.reload();
  const tab = page.locator(".ptab", { hasText: `Renaming files ${stamp}` });
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.click({ button: "right" });
  const dialog = page.getByTestId("edit-project-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Project Description")).toHaveValue("Match the library");
  await dialog.getByLabel("Project Name").fill(`Rename media files ${stamp}`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".ptab", { hasText: `Rename media files ${stamp}` })).toBeVisible();
});
