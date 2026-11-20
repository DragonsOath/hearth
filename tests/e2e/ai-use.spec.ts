import { expect, test } from "@playwright/test";

// AI use with no money (Flint, 11-13): Hearth never charges for AI. A per-use account (Claude
// Code signed in to Anthropic Console) says so, with an optional estimate; an old dollar limit
// from an earlier version shows until it is set or removed.

test("AI use: no money, a per-use note with an opt-in estimate, and the old limit note", async ({
  page,
}) => {
  await page.request.patch("/api/ai/budget", { data: { dailyRuns: null, showEstimate: false } });
  await page.route("**/api/agent/claude/status", (route) =>
    route.fulfill({
      json: { installed: true, loggedIn: true, method: "console", detail: "Signed in." },
    }),
  );
  await page.goto("/settings#cave");
  const box = page.getByTestId("ai-budget");
  await expect(box).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("ai-never-charges")).toHaveText(
    "Hearth never charges for AI. This shows how much of your own AI Ember uses.",
  );
  await expect(page.getByTestId("ai-level")).toHaveText(/Light|Normal|Heavy/);
  // Per use: said plainly, the estimate only once asked for, and never as Hearth's charge.
  const perUse = page.getByTestId("ai-per-use");
  await expect(perUse).toContainText("This provider may charge you per use.");
  await expect(page.getByTestId("ai-estimate")).toHaveCount(0);
  await perUse.getByLabel("Show an estimated cost").check();
  await expect(page.getByTestId("ai-estimate")).toContainText("Billed by Anthropic, not Hearth.");
  await perUse.getByLabel("Show an estimated cost").uncheck();
  await expect(page.getByTestId("ai-estimate")).toHaveCount(0);
  // Outside that note, no money anywhere.
  await expect(box.locator(":not([data-testid=ai-per-use] *)", { hasText: "$" })).toHaveCount(0);

  // An old dollar limit: the note, and Remove it clears it.
  await page.request.patch("/api/ai/budget", { data: { dailyUsd: 5 } });
  await page.reload();
  await expect(page.getByTestId("ai-older-limit")).toContainText(
    "Your old limit from an earlier version is still on. Set a new limit here.",
  );
  await page.getByTestId("ai-older-limit").getByRole("button", { name: "Remove it" }).click();
  await expect(page.getByTestId("ai-older-limit")).toHaveCount(0);
});
