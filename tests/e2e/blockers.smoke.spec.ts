import { expect, test } from "@playwright/test";

// The owner password claim.setup.ts sets (importing it would register its setup again).
const OWNER_PASSWORD = "e2e owner password";

// Blockers resolved where they happen (docs/design/BLOCKERS.md): a panel that needs host
// administration offers it inline, says it is host-wide, needs an explicit tick and a fresh
// "it's you", and reads again by itself once allowed, with no trip to Settings.

test("a panel that needs host administration offers it inline, host-wide, and reads again once allowed", async ({
  page,
}, testInfo) => {
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const request = page.request;
  const res = await request.post("/api/services", {
    data: {
      name: `Gluetun ${run}`,
      kind: "web",
      address: `http://10.${1 + Math.floor(Math.random() * 250)}.7.16:8000`,
      category: "Downloads",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const vpn = ((await res.json()) as { id: string }).id;
  try {
    await page.goto(`/?service=${vpn}`);
    const card = page.getByTestId("blocker-host-admin");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText("is switched off");
    await expect(card).toContainText(/whole of .+, not only this app/);
    // Nothing happens without the explicit tick.
    const allow = card.getByTestId("blocker-allow");
    await expect(allow).toBeDisabled();
    await card.getByTestId("blocker-understood").check();
    await expect(card).toContainText("I understand this applies to all of");
    await allow.click();
    // A fresh "it's you" when the sign-in is not recent; then it is allowed, and the panel
    // reads again by itself: the next answer is about the service, not permission.
    const password = card.getByPlaceholder("Password");
    const after = page.getByTestId("vpn-error").filter({ hasText: /not a Gluetun/ });
    await expect(password.or(after)).toBeVisible({ timeout: 20_000 });
    if (await password.isVisible()) {
      await password.fill(OWNER_PASSWORD);
      await card.getByRole("button", { name: "Confirm", exact: true }).click();
    }
    await expect(after).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("blocker-host-admin")).toHaveCount(0);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    const scopes = (await (await request.get("/api/admin/scopes")).json()) as {
      scopes: { id: string }[];
    };
    for (const s of scopes.scopes) await request.delete(`/api/admin/scopes/${s.id}`);
    await request.post(`/api/services/${vpn}/remove`, { data: {} });
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});

test("switching host administration on asks for a fresh it's-you over the API too", async ({
  page,
}) => {
  const request = page.request;
  const { host } = (await (await request.get("/api/admin/scopes")).json()) as {
    host: { id: string } | null;
  };
  test.skip(!host, "no machine to administer in this run");
  // Signed in long enough ago, the server refuses; confirming the password lets it through.
  const res = await request.post("/api/admin/scopes", {
    data: { hostId: host!.id, operations: ["investigate"] },
  });
  if (res.status() === 403) {
    expect((await res.json()).message).toMatch(/Confirm it's you/);
    expect(
      (await request.post("/api/auth/login", { data: { password: OWNER_PASSWORD } })).status(),
    ).toBe(204);
    expect(
      (
        await request.post("/api/admin/scopes", {
          data: { hostId: host!.id, operations: ["investigate"] },
        })
      ).status(),
    ).toBe(200);
  } else expect(res.status()).toBe(200);
  const scopes = (await (await request.get("/api/admin/scopes")).json()) as {
    scopes: { id: string }[];
  };
  for (const s of scopes.scopes) await request.delete(`/api/admin/scopes/${s.id}`);
});
