import { expect, test } from "@playwright/test";

// Caddy from Hearth (APP_PANELS.md plan). The test server has no Docker or host
// administration, so this checks the panel takes over a Caddy page and says
// plainly why it cannot read it; the reading is unit tested (admin/caddy-panel.test.ts).

test("Caddy panel: Caddy gets its own panel, with a plain reason when it cannot read", async ({
  page,
}) => {
  const request = page.request;
  const res = await request.post("/api/services", {
    data: {
      name: `Caddy`,
      kind: "web",
      address: `http://10.${1 + Math.floor(Math.random() * 250)}.7.25:2019`,
      category: "Downloads",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const cd = ((await res.json()) as { id: string }).id;
  try {
    await page.goto(`/?service=${cd}`);
    const err = page.getByTestId("caddy-error");
    await expect(err).toBeVisible({ timeout: 20_000 });
    await expect(err).toContainText(/switched off|does not know the machine|not a Caddy/);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    // The add/edit form asks the server for exact Caddyfile edits; without host administration
    // that answers with a plain reason, never a change.
    const plan = await request.post(`/api/services/${cd}/caddy/site`, {
      data: { op: "add", site: "books.example.com", upstream: "10.0.0.5:13378" },
    });
    expect(plan.status()).toBe(200);
    const body = (await plan.json()) as { data?: unknown; error?: { message: string } };
    expect(body.data).toBeUndefined();
    expect(body.error?.message).toMatch(/switched off|does not know the machine|not a Caddy/);
  } finally {
    await request.post(`/api/services/${cd}/remove`, { data: {} });
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});
