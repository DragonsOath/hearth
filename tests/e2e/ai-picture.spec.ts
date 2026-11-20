import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// The AI's picture in Settings, Ember (beside its name): one button, every picture to tap.

const activeAvatar = async (request: import("@playwright/test").APIRequestContext) => {
  const v = (await (await request.get("/api/voice")).json()) as {
    active?: string;
    profiles: { id: string; avatar?: string }[];
  };
  return v.profiles.find((p) => p.id === v.active)?.avatar;
};

test("Ember's picture: the ten Ember pictures, previewed, saved, shown everywhere", async ({
  page,
}) => {
  const before = await activeAvatar(page.request);
  // The voice settings as they were (choosing a picture also makes its profile the active one).
  const original = (await (await page.request.get("/api/voice")).json()) as {
    engine: unknown;
    host: unknown;
    sttPort: unknown;
    ttsPort: unknown;
    active?: string;
    profiles: unknown[];
  };
  await page.goto("/settings#cave");
  const field = page.getByTestId("ai-picture-field");
  await expect(field).toBeVisible();
  await field.getByRole("button", { name: "Change picture" }).click();

  const sheet = page.getByTestId("ai-picture-sheet");
  await expect(sheet).toBeVisible();
  // The ten Ember pictures, named, Classic first and the default; and your own library.
  await expect(sheet.getByTestId("look-picker").getByRole("radio")).toHaveCount(10);
  for (const name of [
    "Classic Ember (default)",
    "Chatty Ember",
    "Manager Ember",
    "Detective Ember",
    "Engineer Ember",
    "Gamer Ember",
    "IT Ember",
    "Cosmic Ember",
    "Arcane Ember",
    "Cozy Ember",
  ])
    await expect(sheet.getByRole("radio", { name, exact: true })).toBeVisible();
  for (const old of ["Guardian", "Operator", "Enchantress", "Scholar", "Companion"])
    await expect(sheet.getByText(old)).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: /Choose from your library/ })).toBeVisible();
  const axe = await new AxeBuilder({ page }).include('[data-testid="ai-picture-sheet"]').analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual(
    [],
  );

  // A tap previews it; nothing is saved until Save.
  await sheet.getByRole("radio", { name: "Cosmic Ember", exact: true }).check();
  const preview = sheet.getByTestId("ai-picture-preview");
  await expect(preview.getByRole("img")).toHaveAttribute("src", "/avatars/ember-cosmic.webp");
  await expect(preview).toContainText("Cosmic Ember");
  expect(await activeAvatar(page.request)).toBe(before);
  // Cancel keeps the picture as it was.
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toHaveCount(0);
  expect(await activeAvatar(page.request)).toBe(before);

  // Save puts it everywhere, and it is still chosen after a reload.
  await field.getByRole("button", { name: "Change picture" }).click();
  await page.getByTestId("ai-picture-sheet").getByRole("radio", { name: "Gamer Ember" }).check();
  await page
    .getByTestId("ai-picture-sheet")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByTestId("ai-picture-sheet")).toHaveCount(0);
  await expect.poll(() => activeAvatar(page.request)).toBe("/avatars/ember-gamer.webp");
  await page.reload();
  await expect(field.getByRole("img")).toHaveAttribute("src", "/avatars/ember-gamer.webp");
  await field.getByRole("button", { name: "Change picture" }).click();
  await expect(
    page.getByTestId("ai-picture-sheet").getByRole("radio", { name: "Gamer Ember" }),
  ).toBeChecked();
  // Turn on persona (11-07): off by default; on, the picture's example line shows before
  // Save, and it is still on after a reload.
  const persona = page.getByTestId("ai-picture-sheet").getByTestId("look-persona");
  const toggle = persona.getByRole("switch", { name: "Turn on persona" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(persona.getByTestId("look-persona-preview")).toHaveCount(0);
  await toggle.click();
  await expect(persona.getByTestId("look-persona-preview")).toContainText("One respawn");
  await page
    .getByTestId("ai-picture-sheet")
    .getByRole("radio", { name: "Detective Ember", exact: true })
    .check();
  await expect(persona.getByTestId("look-persona-preview")).toContainText("Elementary, really.");
  await page
    .getByTestId("ai-picture-sheet")
    .getByRole("radio", { name: "Gamer Ember", exact: true })
    .check();
  await page
    .getByTestId("ai-picture-sheet")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByTestId("ai-picture-sheet")).toHaveCount(0);
  await expect
    .poll(async () => (await (await page.request.get("/api/agent/look-persona")).json()).on)
    .toBe(true);
  await page.reload();
  await field.getByRole("button", { name: "Change picture" }).click();
  await expect(
    page.getByTestId("look-persona").getByRole("switch", { name: "Turn on persona" }),
  ).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Cancel" }).click();
  // Off again for the other tests.
  expect((await page.request.put("/api/agent/look-persona", { data: { on: false } })).ok()).toBe(
    true,
  );

  // Leave the voice settings exactly as they were for the other tests: the same profiles and
  // pictures, and the same active profile (none, on a fresh install).
  const res = await page.request.put("/api/voice", {
    data: {
      engine: original.engine,
      host: original.host,
      sttPort: original.sttPort,
      ttsPort: original.ttsPort,
      ...(original.active ? { active: original.active } : {}),
      profiles: original.profiles,
    },
  });
  expect(res.ok()).toBe(true);
  expect(await activeAvatar(page.request)).toBe(before);
});
