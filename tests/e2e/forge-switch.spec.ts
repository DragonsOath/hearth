import { expect, test, type APIRequestContext } from "@playwright/test";

// The Forge (the owner, 11-11): with more than one project waiting, an arrow on the sheet goes to
// the next one in the same place, like swiping, and back.

async function sheet(request: APIRequestContext, text: string) {
  const { conversationId } = (await (
    await request.post("/api/agent/conversations", { data: { text, wait: 20 } })
  ).json()) as { conversationId: string };
  for (let i = 0; i < 40; i++) {
    const all = (await (await request.get("/api/workspaces?kind=temporary")).json()) as {
      id: string;
      title: string;
      conversationId?: string;
    }[];
    const w = all.find((x) => x.conversationId === conversationId);
    if (w) return w;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("no sheet");
}

test("the arrows on a Forge sheet switch to the next waiting project and back", async ({
  page,
}) => {
  // It clears the waiting sheets to know the count: one browser run only, so they never collide.
  test.skip(test.info().project.name === "mobile", "clears the shared waiting sheets");
  test.setTimeout(120_000);
  const request = page.request;
  // Only the sheets made here are waiting, so the count is known.
  for (const w of (await (await request.get("/api/workspaces?kind=temporary")).json()) as {
    id: string;
  }[])
    await request.delete(`/api/workspaces/${w.id}`);
  await request.post("/api/agent/providers/claude-code/connect", { data: {} });
  const a = await sheet(request, "pick a test collection of 5 from 12");
  const b = await sheet(request, "pick a test collection of 5 from 12");
  const c = await sheet(request, "pick a test collection of 5 from 12");

  await page.goto(`/?panels=workspace:${a.id}`);
  const panel = page.getByTestId("workspace-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const sw = panel.getByTestId("forge-switch");
  await expect(sw).toContainText(/Project \d of 3/);
  const first = await sw.textContent();

  await sw.getByTestId("forge-next").click();
  await expect(page).toHaveURL(new RegExp(`workspace(%3A|:)${b.id}`));
  await expect(page.getByTestId("workspace-panel")).toHaveCount(1);
  await expect(page.getByTestId("forge-switch")).not.toHaveText(first ?? "");

  await page.getByTestId("forge-switch").getByTestId("forge-prev").click();
  await expect(page).toHaveURL(new RegExp(`workspace(%3A|:)${a.id}`));
  await expect(page.getByTestId("workspace-panel")).toHaveCount(1);

  // The count moves and stays put (the owner, 11-14: it said "1 of 3" always, because opening a
  // project moved it to the front): forward three times visits all three and comes back.
  const seen = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const text = (await page.getByTestId("forge-switch").textContent()) ?? "";
    seen.add(/Project (\d) of 3/.exec(text)?.[1] ?? "?");
    await page.getByTestId("forge-switch").getByTestId("forge-next").click();
    await expect(page.getByTestId("forge-switch")).not.toHaveText(text);
  }
  expect([...seen].sort()).toEqual(["1", "2", "3"]);
  await expect(page).toHaveURL(new RegExp(`workspace(%3A|:)${a.id}`));

  for (const w of [a, b, c]) await request.delete(`/api/workspaces/${w.id}`);
});
