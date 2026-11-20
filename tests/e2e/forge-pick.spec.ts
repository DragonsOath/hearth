import { expect, test } from "@playwright/test";

// The Forge pick layout (checklist 45.15): choosing a set (a Plex collection's titles). Selected
// beside Alternatives, with search, add, remove and swap, and the count against the target; on a
// phone, a Selected / Alternatives switch. Choices are saved as they are made and submitted as
// they are shown.

test("the Forge pick layout: add, remove, swap, search, the count against the target, then send", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const phone = test.info().project.name === "mobile";
  await page.request.post("/api/agent/providers/claude-code/connect", { data: {} });
  // Its own conversation (not the Lair's main one), so nothing here is left for other tests.
  const { conversationId } = (await (
    await page.request.post("/api/agent/conversations", {
      data: { text: "pick a test collection of 5 from 12", wait: 20 },
    })
  ).json()) as { conversationId: string };
  let wsId: string | undefined;
  for (let i = 0; i < 40 && !wsId; i++) {
    const all = (await (await page.request.get("/api/workspaces?kind=temporary")).json()) as {
      id: string;
      conversationId?: string;
    }[];
    wsId = all.find((w) => w.conversationId === conversationId)?.id;
    if (!wsId) await page.waitForTimeout(500);
  }
  await page.goto(`/?panels=workspace:${wsId}`);

  const panel = page.getByTestId("workspace-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const count = panel.getByTestId("pick-count");
  await expect(count).toHaveText("5 of 5 selected");
  const selected = panel.getByTestId("pick-selected");
  const alternatives = panel.getByTestId("pick-alternatives");
  if (phone) {
    // One list at a time on a phone.
    await expect(selected).toBeVisible();
    await expect(alternatives).toHaveCount(0);
  } else {
    await expect(selected.getByTestId("pick-item")).toHaveCount(5);
    await expect(alternatives.getByTestId("pick-item")).toHaveCount(7);
  }

  // Remove one: 4 of 5, one to go.
  await selected.getByRole("button", { name: "Remove Sample Film 2" }).click();
  await expect(count).toHaveText("4 of 5 selected: 1 to go");
  // Add one back from the alternatives (searched for).
  if (phone) await panel.getByRole("tab", { name: /Alternatives/ }).click();
  await panel.getByPlaceholder(/Search or filter/).fill("Film 9");
  await expect(panel.getByTestId("pick-alternatives").getByTestId("pick-item")).toHaveCount(1);
  await panel.getByRole("button", { name: "Add Sample Film 9" }).click();
  await expect(count).toHaveText("5 of 5 selected");
  await panel.getByPlaceholder(/Search or filter/).fill("");

  // Swap: Film 1 out, Film 12 in, the count unchanged.
  if (phone) await panel.getByRole("tab", { name: /Selected/ }).click();
  await panel.getByRole("button", { name: "Swap Sample Film 1" }).click();
  await panel.getByRole("button", { name: "Swap in Sample Film 12" }).click();
  await expect(count).toHaveText("5 of 5 selected");
  if (phone) await panel.getByRole("tab", { name: /Selected/ }).click();
  await expect(panel.getByTestId("pick-selected")).toContainText("Sample Film 12");
  const ids = await panel
    .getByTestId("pick-selected")
    .getByTestId("pick-item")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-item")));
  expect(ids).not.toContain("500");
  await page.screenshot({
    path: `test-results/screens/${test.info().project.name}/forge-pick.png`,
  });

  // Saved as made: a reload finds the same selection.
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.getByTestId("pick-count")).toHaveText("5 of 5 selected", { timeout: 20_000 });

  // Sending: the submission is exactly what Selected shows.
  await page.getByRole("button", { name: /Send my selection to/ }).click();
  await expect(page.getByTestId("workspace-panel")).toContainText(/Sent \d/, { timeout: 15_000 });
  const list = await (await page.request.get("/api/workspaces?kind=temporary")).json();
  const ws = list.find((w: { title: string }) => w.title === "Test collection");
  const view = await (await page.request.get(`/api/workspaces/${ws.id}`)).json();
  const chosen = Object.entries(view.submission.decisions as Record<string, string>)
    .filter(([, v]) => v === "include")
    .map(([k]) => k)
    .sort();
  // Films 1..5 were picked (ids 500..504); 2 (501) out, 9 (508) in, 1 (500) swapped for 12 (511).
  expect(chosen).toEqual(["502", "503", "504", "508", "511"]);
  await page.request.delete(`/api/workspaces/${ws.id}`);
});

// Tests share one Hearth: wait for Ember's answer to the submission, then close every sheet this
// file opened, so the next file starts with none.
test.afterEach(async ({ request }) => {
  for (let i = 0; i < 30; i++) {
    const list = (await (await request.get("/api/agent/conversations")).json()) as {
      status: string;
    }[];
    if (!list.some((c) => c.status === "working")) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const open = (await (await request.get("/api/workspaces?kind=temporary")).json()) as {
    id: string;
  }[];
  for (const w of open) await request.delete(`/api/workspaces/${w.id}`);
});

// Tests share one Hearth: leave no AI connected for the next file.
test.afterAll(async ({ request }) => {
  await request.post("/api/agent/disconnect", { data: {} });
});
