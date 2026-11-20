import { expect, test } from "@playwright/test";

// Tinyauth from Hearth (APP_PANELS.md plan). The test server has no Docker or host
// administration, so this checks the panel takes over a Tinyauth page and says
// plainly why it cannot read its log; the log reading is unit tested (apps/tinyauth.test.ts).

test("Tinyauth panel: it gets its own panel, with a plain reason when it cannot read", async ({
  page,
}, testInfo) => {
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const request = page.request;
  const res = await request.post("/api/services", {
    data: {
      name: `Tinyauth ${run}`,
      kind: "web",
      address: `http://10.${1 + Math.floor(Math.random() * 250)}.7.26:3011`,
      category: "Network",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const fs = ((await res.json()) as { id: string }).id;
  try {
    await page.goto(`/?service=${fs}`);
    const err = page.getByTestId("ta-error");
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

// What it does, which sites it guards and which are open (read from Caddy), and putting an open
// one behind it with the Caddy panel's own protected change. The test server has no Caddy to read,
// so Caddy's answer is given here; the plan request is checked, then stopped before any change.
test("Tinyauth panel: what it does, the sites it guards, and putting one behind it", async ({
  page,
}, testInfo) => {
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const request = page.request;
  const add = async (name: string, port: number) => {
    const res = await request.post("/api/services", {
      data: {
        name,
        kind: "web",
        address: `http://10.${1 + Math.floor(Math.random() * 250)}.8.27:${port}`,
        category: "Network",
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const caddy = await add("Caddy", 2019);
  const ta = await add(`Tinyauth ${run}`, 3011);
  await page.route("**/api/services/*/caddy", (route) =>
    route.fulfill({
      json: {
        data: {
          manage: { ok: true, path: "/srv/caddy/Caddyfile" },
          sites: [
            { hosts: ["auth.example.com"], upstreams: ["tinyauth:3000"], signIn: "none" },
            {
              hosts: ["photos.example.com"],
              upstreams: ["10.0.0.5:2283"],
              signIn: "sign-in service",
              signInVia: "tinyauth:3000",
            },
            { hosts: ["books.example.com"], upstreams: ["10.0.0.5:13378"], signIn: "none" },
            { hosts: ["old.example.com"], upstreams: [], signIn: "none", fixed: true },
          ],
        },
      },
    }),
  );
  let planned: unknown;
  await page.route("**/api/services/*/caddy/site", async (route) => {
    planned = route.request().postDataJSON();
    await route.fulfill({ json: { error: { message: "Stopped by the test before any change." } } });
  });
  try {
    await page.goto(`/?service=${ta}`);
    await expect(page.getByTestId("ta-guide")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("ta-behind")).toContainText("photos.example.com");
    const open = page.getByTestId("ta-open");
    // The sign-in service itself and a redirect are not offered.
    await expect(open.getByTestId("ta-open-site")).toHaveText([/books\.example\.com/]);
    await open.getByRole("button", { name: "Protect it" }).click();
    await expect(open).toContainText("Anyone opening books.example.com will see the");
    await open.getByTestId("ta-protect-plan").click();
    await expect(open.getByRole("alert")).toContainText("Stopped by the test");
    expect(planned).toEqual({
      op: "change",
      site: "books.example.com",
      upstream: "10.0.0.5:13378",
      signIn: "sign-in service",
    });
    // Not a container Hearth knows: it says so, and changes are not offered.
    await expect(page.getByTestId("ta-users-why")).toContainText("does not know which container");
  } finally {
    await request.post(`/api/services/${ta}/remove`, { data: {} });
    await request.post(`/api/services/${caddy}/remove`, { data: {} });
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});

// Changing a password from the panel. The test server has no Tinyauth container, so its users list
// and the reference for a typed password are given here; the plan request is checked (it carries
// only the reference, never the password), then stopped before any change.
test("Tinyauth panel: change a password, the plan carrying only a reference to it", async ({
  page,
}, testInfo) => {
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const request = page.request;
  const res = await request.post("/api/services", {
    data: {
      name: `Tinyauth ${run}`,
      kind: "web",
      address: `http://10.${1 + Math.floor(Math.random() * 250)}.9.28:3011`,
      category: "Network",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const ta = ((await res.json()) as { id: string }).id;
  await page.route("**/tinyauth/users", (route) =>
    route.fulfill({
      json: {
        source: "file",
        editable: true,
        users: [
          { username: "owner", twoStep: false },
          { username: "family", twoStep: true },
        ],
      },
    }),
  );
  let typed: unknown;
  await page.route("**/tinyauth/users/password", async (route) => {
    typed = route.request().postDataJSON();
    await route.fulfill({ json: { ref: "pw-0123456789abcdef01234567" } });
  });
  let plan = "";
  await page.route("**/api/jobs", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    plan = route.request().postData() ?? "";
    await route.fulfill({
      status: 409,
      json: { error: "Conflict", message: "Stopped by the test." },
    });
  });
  try {
    await page.goto(`/?service=${ta}`);
    const users = page.getByTestId("ta-users");
    await expect(users.getByTestId("ta-user")).toHaveCount(2, { timeout: 20_000 });
    await expect(users.getByTestId("ta-user").nth(1)).toContainText("sign-in code on");
    await users
      .getByTestId("ta-user")
      .first()
      .getByRole("button", { name: "Change password" })
      .click();
    const form = users.getByTestId("ta-user-form");
    await form.getByTestId("ta-password").fill("a new e2e password");
    await form.getByTestId("ta-password-repeat").fill("not the same");
    await form.getByTestId("ta-user-plan").click();
    await expect(form.getByRole("alert")).toContainText("not the same");
    await form.getByTestId("ta-password-repeat").fill("a new e2e password");
    await form.getByTestId("ta-user-plan").click();
    await expect.poll(() => plan).not.toBe("");
    expect(typed).toEqual({ username: "owner", password: "a new e2e password" });
    expect(plan).toContain('"kind":"tinyauth-users"');
    expect(plan).toContain("pw-0123456789abcdef01234567");
    expect(plan).not.toContain("a new e2e password");
  } finally {
    await request.post(`/api/services/${ta}/remove`, { data: {} });
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});
