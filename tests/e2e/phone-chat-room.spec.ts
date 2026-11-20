import { expect, test } from "@playwright/test";

// A phone (11-18, the owner: "too small for mobile, the AI responses reading field needs more
// space"): on Home, Ember's conversation takes most of the screen, answers run the full width,
// and the model picker lives in the chat's menu instead of its own row.

test("on a phone, Ember's conversation gets most of the screen", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "A phone's layout.");
  await page.request.post("/api/agent/providers/claude-code/connect", { data: {} });
  await page.goto(`/?panels=${encodeURIComponent("tool:crucible")}&view=chat`);
  const thread = page.getByTestId("cave-thread").first();
  await expect(thread).toBeVisible({ timeout: 20_000 });
  await page.getByRole("textbox").last().fill("What needs me today?");
  await page.getByRole("button", { name: "Send" }).last().click();
  await expect(page.getByTestId("answer").first()).toBeVisible({ timeout: 30_000 });

  const vh = page.viewportSize()!.height;
  const t = (await thread.boundingBox())!;
  const bar = (await page.getByTestId("tab-bar").boundingBox())!;
  const frame = (await page.locator("[data-ember-frame]").first().boundingBox())!;
  await page.screenshot({ path: "test-results/screens/phone-chat-room.png" });
  // The chat starts near the top of the screen now the header steps aside.
  expect(frame.y).toBeLessThan(90);
  // The card reaches down to just above the tab bar.
  expect(bar.y - (frame.y + frame.height)).toBeLessThan(20);
  // The thread itself is most of what's left.
  expect(t.height / vh).toBeGreaterThan(0.45);
  // An answer uses the width (no picture column beside it on a phone).
  const a = (await page.getByTestId("answer").first().boundingBox())!;
  expect(a.width / t.width).toBeGreaterThan(0.85);
  // The model picker isn't under the box; it's in the menu.
  await expect(page.getByTestId("cave-model")).toHaveCount(0);
  // No header and no Ember or Minimize buttons above the chat (11-18): they're in the menu too.
  await expect(page.getByTestId("phone-header")).toBeHidden();
  await expect(page.getByTestId("carousel-ember")).toBeHidden();
  await expect(page.getByRole("button", { name: "Minimize all" })).toBeHidden();
  await expect(page.getByTestId("carousel-current")).toBeVisible();
  await page.getByTestId("chat-menu").click();
  const menu = page.getByTestId("chat-menu-drawer");
  await expect(menu.getByTestId("cave-model")).toBeVisible();
  await expect(menu.getByTestId("overall-status-menu")).toBeVisible();
  await expect(menu.getByTestId("phone-lair-button")).toBeVisible();
  await expect(menu.getByTestId("chat-menu-minimize")).toBeVisible();
  await page.screenshot({ path: "test-results/screens/phone-chat-menu.png" });
  await page.getByRole("button", { name: "Close the menu" }).first().click();
  // A panel in front: the header and the bar's buttons come back.
  await page.getByTestId("carousel-next").click();
  await expect(page.getByTestId("phone-header")).toBeVisible();
  await expect(page.getByTestId("carousel-ember")).toBeVisible();
});
