import { expect, test } from "@playwright/test";

// FlareSolverr from Hearth (APP_PANELS.md plan). The test server has no Docker or host
// administration, so this checks the panel takes over a FlareSolverr page and says
// plainly why it cannot read its log; the log reading is unit tested (apps/flaresolverr.test.ts).

test("FlareSolverr panel: it gets its own panel, with a plain reason when it cannot read", async ({
  page,
}, testInfo) => {
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const request = page.request;
  const res = await request.post("/api/services", {
    data: {
      name: `FlareSolverr ${run}`,
      kind: "web",
      address: `http://10.${1 + Math.floor(Math.random() * 250)}.7.24:8191`,
      category: "Downloads",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const fs = ((await res.json()) as { id: string }).id;
  try {
    await page.goto(`/?service=${fs}`);
    const err = page.getByTestId("fs-error");
    await expect(err).toBeVisible({ timeout: 20_000 });
    await expect(err).toContainText(/does not know which container|Docker/);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await request.post(`/api/services/${fs}/remove`, { data: {} });
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});
