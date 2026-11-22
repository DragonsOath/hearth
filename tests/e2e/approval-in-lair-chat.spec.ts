import { expect, test } from "@playwright/test";

// Approvals where you are (11-22, the owner: "any time something needs the owner's approval, the
// approval shows on the screen they're on"). A plan proposed in a chat renders in that chat with
// Approve and Decline, Ember's result follows there, and on any other page a plan waiting for you
// slides in with the same buttons, so the Jobs page is never the only way.

// The test AI answers (connected for these tests, put back as it was after).
let wasConnected = true;
test.beforeEach(async ({ page }) => {
  const ws = (await (await page.request.get("/api/workspace")).json()) as {
    operator: { agentId?: string | null };
  };
  wasConnected = Boolean(ws.operator.agentId);
  await page.request.post("/api/agent/providers/claude-code/connect", { data: {} });
});
test.afterEach(async ({ page }) => {
  if (!wasConnected) await page.request.post("/api/agent/disconnect", { data: {} });
});

test("an approval proposed in a chat renders in that chat, and the result follows there", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.goto("/ask");
  await page.locator("textarea").first().fill("Plan a quick check of my services");
  await page.getByRole("button", { name: "Send" }).first().click();
  const thread = page.getByTestId("cave-thread");
  await expect(thread.getByTestId("answer").last()).toContainText("approval card is just below", {
    timeout: 30_000,
  });
  // The card is in the chat, under the answer: the plan, Approve and Decline.
  const card = thread.getByTestId("cave-job").last();
  await expect(card).toBeVisible();
  await expect(card).toContainText("Plan:");
  await expect(card.getByRole("button", { name: "Decline" })).toBeVisible();
  // It is on screen, so no second copy slides in.
  await expect(page.getByTestId("approval-dock")).toHaveCount(0);
  await card.screenshot({
    path: `test-results/screens/${testInfo.project.name}/approval-in-chat.png`,
  });
  await card.getByRole("button", { name: "Approve and run" }).click();
  await expect(card.getByTestId("job-approved")).toBeVisible({ timeout: 20_000 });
  // How it went, in the same chat.
  await expect(thread).toContainText("Plan finished.", { timeout: 30_000 });
});

test("on any other page, a plan waiting for you slides in with Approve and Decline", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  // Ember plans it in a chat that is not on screen.
  const asked = await page.request.post("/api/agent/conversations", {
    data: { text: "Plan a quick check of my services" },
  });
  expect(asked.ok(), await asked.text()).toBe(true);
  await page.goto("/settings");
  const dock = page.getByTestId("approval-dock");
  await expect(dock).toBeVisible({ timeout: 30_000 });
  await expect(dock).toContainText("Needs your approval");
  const card = dock.getByTestId("cave-job").last();
  await expect(card.getByRole("button", { name: "Approve and run" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Decline" })).toBeVisible();
  await dock.screenshot({
    path: `test-results/screens/${testInfo.project.name}/approval-dock.png`,
  });
  await card.getByRole("button", { name: "Approve and run" }).click();
  await expect(card.getByTestId("job-approved")).toBeVisible({ timeout: 20_000 });
  // Decided here: it stays to show how it went until closed.
  await dock.getByTestId("approval-dock-later").last().click();
  await expect(dock.getByTestId("approval-dock-plan")).toHaveCount(0);
});
