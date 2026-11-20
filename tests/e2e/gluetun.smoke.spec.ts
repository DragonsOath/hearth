import { expect, test } from "@playwright/test";

// Gluetun from Hearth (APP_PANELS.md plan). The test server has no Docker or host
// administration, so this checks the panel takes over a Gluetun container's page and says
// plainly why it cannot read the VPN; the read itself is unit tested (admin/vpn-panel.test.ts).

test("Gluetun panel: a VPN container gets its own panel, with a plain reason when it cannot read", async ({
  page,
}, testInfo) => {
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const request = page.request;
  const res = await request.post("/api/services", {
    data: {
      name: `Gluetun ${run}`,
      kind: "web",
      address: `http://10.${1 + Math.floor(Math.random() * 250)}.7.15:8000`,
      category: "Downloads",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const vpn = ((await res.json()) as { id: string }).id;
  try {
    await page.goto(`/?service=${vpn}`);
    const err = page.getByTestId("vpn-error");
    await expect(err).toBeVisible({ timeout: 20_000 });
    await expect(err).toContainText(/switched off|does not know the machine|not a Gluetun/);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await request.post(`/api/services/${vpn}/remove`, { data: {} });
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});
