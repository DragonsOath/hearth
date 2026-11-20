import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// The to-do list as a panel in the Lair (the owner, 2026-11-02): a switch in the row of systems,
// like Storage & Files, and on a phone a panel in the ring.

test.beforeEach(async ({ request }) => {
  const res = await request.post("/api/demo/scenario", {
    data: { scenario: "calm", replaceYourSystems: true },
  });
  expect(res.status()).toBe(204);
});

test("To-do opens as a panel in the Lair: add, tick off, see it under Done", async ({
  page,
  isMobile,
}, testInfo) => {
  const title = `Check the backup drive ${Date.now()}`;
  if (isMobile) {
    await page.goto(`/?panels=${encodeURIComponent("tool:todo")}`);
  } else {
    await page.goto("/?panels=");
    const chip = page.getByTestId("lair-todo");
    await expect(chip).toHaveAttribute("aria-pressed", "false");
    // Ember with the clipboard, beside Ember at the filing cabinet for Storage.
    await expect(chip.locator("img")).toHaveAttribute("src", "/brand/ember-todo.webp");
    await expect(page.getByTestId("lair-storage").locator("img")).toHaveAttribute(
      "src",
      "/brand/ember-storage.webp",
    );
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
  }
  const panel = page.getByTestId("todo-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "To-do" })).toBeVisible();

  // Add one, then tick it off: it moves to Done.
  await panel.getByRole("textbox", { name: "New to-do item" }).fill(title);
  await panel.getByRole("button", { name: "Add the task" }).click();
  const item = panel.getByRole("checkbox", { name: `Mark done: ${title}` });
  await expect(item).toBeVisible();

  // Work on this (11-11): Ember gets the task with its context; nothing is ticked off.
  await panel.getByRole("button", { name: `Work on this with Ember: ${title}` }).click();
  await expect(item).not.toBeChecked();
  // The conversation is linked to the task, so the next Work on this goes back to it.
  const linked = async () => {
    const list = (await (await page.request.get("/api/todos")).json()) as {
      title: string;
      conversationId?: string;
    }[];
    return list.find((x) => x.title === title)?.conversationId;
  };
  await expect.poll(linked, { timeout: 20_000 }).toBeTruthy();
  const said = async () =>
    JSON.stringify(
      await (await page.request.get(`/api/agent/conversations/${await linked()}`)).json(),
    );
  expect(await said()).toMatch(new RegExp(`Let's work on to-do #\\d+ \\(id [^)]+\\): “${title}”`));
  if (!isMobile) {
    await panel.getByRole("button", { name: `Work on this with Ember: ${title}` }).click();
    await expect.poll(said, { timeout: 20_000 }).toMatch(/Back to to-do #\d+, “/);
  }
  await item.click();
  await expect(item).toHaveCount(0);
  await panel.getByRole("tab", { name: "Done" }).click();
  await expect(panel.getByRole("checkbox", { name: `Reopen: ${title}` })).toBeChecked();
  await page.screenshot({ path: `test-results/screens/${testInfo.project.name}/todo-panel.png` });

  // Its own switch is hidden: the panel's tabs choose, so there is one set of tabs.
  await expect(panel.getByRole("tablist", { name: "Which items" })).toBeHidden();
  const axe = await new AxeBuilder({ page }).include('[data-testid="todo-panel"]').analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual(
    [],
  );

  // The whole list is one tap away.
  await expect(panel.getByRole("link", { name: "The whole list" })).toHaveAttribute(
    "href",
    "/todo",
  );
});
