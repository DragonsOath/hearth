import { createServer, type Server } from "node:http";
import { type APIRequestContext, expect, test } from "@playwright/test";

// Ember's Browser (checklist 45.12): a real browser Hearth runs for Ember, watched live in its
// panel. The pages come from a small server in this test (the test Hearth may open this
// machine's addresses; production never does).

let server: Server;
let base = "";
test.beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.url?.startsWith("/check"))
      return res.end(
        "<title>Are you human?</title><body style='background:#123;color:#fff;font:28px sans-serif'><h1 id='out'>Prove you are human</h1><div style='position:absolute;left:0;top:200px;width:1280px;height:300px;background:#246' onclick=\"document.getElementById('out').textContent='Thanks, human'\">I am human</div></body>",
      );
    if (req.url?.startsWith("/refuse")) {
      res.statusCode = 403;
      return res.end("<title>403 Forbidden</title><h1>Forbidden</h1>");
    }
    if (req.url?.startsWith("/reviews"))
      return res.end(
        "<title>Classic horror reviews</title><body style='background:#123;color:#fff;font:28px sans-serif'><h1>Reviews</h1><p>Night of the Living Dead (1968): 96% of critics</p></body>",
      );
    res.end(
      "<title>Horror archive</title><body style='background:#321;color:#fff;font:28px sans-serif'><h1>Horror archive</h1><p>Public-domain classics.</p><a href='/reviews' style='font-size:40px'>Read the reviews</a></body>",
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
// Tests share one Hearth: sheets and saved workspaces other tests left open would open beside
// the chat (on a phone, in its place), so each test here starts without them.
test.beforeEach(async ({ request }) => {
  // An answer another test left running would land here (a sheet it makes comes to the front).
  await settled(request);
  for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
    await request.delete(`/api/desk/groups/${g.id}`);
  for (const w of (await (await request.get("/api/workspaces")).json()) as { id: string }[])
    await request.delete(`/api/workspaces/${w.id}?saved=1`);
});
// Tests share one Hearth: nothing handed over or still answering is left for the next test.
test.afterEach(async ({ request }) => {
  await request.post("/api/browser/owner", { data: { action: "give-back" } });
  await settled(request);
});
async function settled(request: APIRequestContext) {
  for (let i = 0; i < 60; i++) {
    const list = (await (await request.get("/api/agent/conversations")).json()) as {
      status: string;
    }[];
    if (!list.some((c) => c.status === "working")) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}
test.afterAll(async ({ request }) => {
  await request.post("/api/browser/owner", { data: { action: "close" } });
  await request.post("/api/agent/disconnect", { data: {} });
  server.close();
});

test("stuck on a check, Ember hands you the page; you do it, give it back, and she carries on", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.request.post("/api/agent/providers/claude-code/connect", { data: {} });
  // The chat itself, also on a phone (where a sheet left open by another test would show first).
  await page.goto("/?panels=&view=chat");
  await page.locator("textarea").first().fill(`browse ${base}/check and ask me`);
  await page.getByRole("button", { name: "Send" }).first().click();
  await expect(
    page.getByTestId("answer").filter({ hasText: "Over to you", visible: true }).last(),
  ).toBeVisible({
    timeout: 45_000,
  });
  // The conversation says what she needs, with the way to the browser.
  const prompt = page.getByTestId("cave-browser-handover");
  await expect(prompt).toContainText("needs you in the browser: solve the check", {
    timeout: 10_000,
  });
  await prompt.getByRole("link", { name: /Browser/ }).click();
  const panel = page.getByTestId("browser-panel").first();
  await expect(panel.getByTestId("browser-handover")).toContainText("solve the check");
  await expect(panel.getByTestId("browser-live")).toBeVisible();
  // You click on the page itself, in the live picture.
  const surface = panel.getByTestId("browser-owner-surface");
  const box = (await surface.boundingBox())!;
  await surface.click({ position: { x: box.width / 2, y: box.height * 0.45 } });
  await expect
    .poll(async () => {
      const s = (await (await page.request.get("/api/browser/state")).json()) as {
        last?: { label: string };
      };
      return s.last?.label;
    })
    .toBeTruthy();
  await page.screenshot({
    path: `test-results/screens/${test.info().project.name}/browser-handover.png`,
  });
  await panel.getByRole("button", { name: "Give it back" }).click();
  await expect(panel.getByTestId("browser-handover")).toHaveCount(0);
  // She carries on by herself, from the page as you left it, and the chat shows it.
  await expect
    .poll(
      async () => {
        const main = (await (await page.request.get("/api/agent/conversations/main")).json()) as {
          messages: { text: string }[];
        };
        return main.messages.some((m) => m.text.includes("Thanks, human"));
      },
      { timeout: 45_000 },
    )
    .toBe(true);
  if (test.info().project.name !== "mobile")
    await expect(
      page.getByTestId("answer").filter({ hasText: "Thanks, human", visible: true }),
    ).toBeVisible({
      timeout: 15_000,
    });
});

test("a site refuses the background browser: Ember says so, asks for a visible window, and carries on when you allow it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.request.post("/api/agent/providers/claude-code/connect", { data: {} });
  // The chat itself, also on a phone (where a sheet left open by another test would show first).
  await page.goto("/?panels=&view=chat");
  await page.locator("textarea").first().fill(`browse ${base}/refuse and it refuses`);
  await page.getByRole("button", { name: "Send" }).first().click();
  await expect(
    page
      .getByTestId("answer")
      .filter({ hasText: "refuses automated browsers outright", visible: true })
      .last(),
  ).toBeVisible({ timeout: 45_000 });
  // The conversation asks, plainly, with Open it, Always and No.
  const ask = page.getByTestId("cave-browser-visible-ask");
  await expect(ask).toContainText("127.0.0.1 refuses", { timeout: 10_000 });
  await ask.scrollIntoViewIfNeeded();
  await page.getByTestId("cave-thread").screenshot({
    path: `test-results/screens/${test.info().project.name}/browser-visible-ask.png`,
  });
  await ask.getByRole("button", { name: "Always for 127.0.0.1" }).click();
  await expect(ask).toHaveCount(0);
  // She carries on by herself in the visible window, and the site is remembered.
  await expect
    .poll(
      async () => {
        const main = (await (await page.request.get("/api/agent/conversations/main")).json()) as {
          messages: { text: string }[];
        };
        return main.messages.some((m) => m.text.includes("Carried on in the visible window"));
      },
      { timeout: 45_000 },
    )
    .toBe(true);
  const state = (await (await page.request.get("/api/browser/state")).json()) as {
    window: string;
    visibleSites: string[];
  };
  expect(state).toMatchObject({ window: "visible", visibleSites: ["127.0.0.1"] });
  await page.request.post("/api/browser/owner", {
    data: { action: "forget-site", host: "127.0.0.1" },
  });
  await page.request.post("/api/browser/owner", { data: { action: "close" } });
});

test("you can open the browser yourself, watch frames arrive, and close it", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/?panels=tool:browser");
  const panel =
    test.info().project.name === "mobile"
      ? page.getByTestId("browser-panel")
      : page.locator('[data-panel="tool:browser"]');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await panel.locator('[data-hearth-target="browser:address"]').fill(`${base}/reviews`);
  await panel.locator('[data-hearth-target="browser:go"]').click();
  await expect(panel.getByTestId("browser-last")).toContainText("You", { timeout: 20_000 });
  // Real frames from the page's screencast: the picture has a size once one arrives.
  const live = panel.getByTestId("browser-live");
  await expect(live).toBeVisible();
  await expect
    .poll(() => live.evaluate((img) => (img as HTMLImageElement).naturalWidth), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  // The page takes the panel's shape: the picture fills the free space, nothing left empty.
  await expect
    .poll(
      async () => {
        const a = (await panel.getByTestId("browser-area").boundingBox())!;
        const f = (await panel.getByTestId("browser-screen").boundingBox())!;
        return Math.min(f.width / a.width, f.height / a.height);
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0.97);
  await page.screenshot({
    path: `test-results/screens/${test.info().project.name}/browser-fills.png`,
  });
  await expect(panel.locator('[data-hearth-target="browser:address"]')).toHaveValue(
    `${base}/reviews`,
  );
  await panel.locator('[data-hearth-target="browser:close"]').click();
  await expect(panel).toContainText("Not running", { timeout: 10_000 });
  // Idle, the screen still takes all the room under the toolbar (11-11), not a page-shaped box.
  const a = (await panel.getByTestId("browser-area").boundingBox())!;
  const s = (await panel.getByTestId("browser-screen").boundingBox())!;
  expect(s.width / a.width).toBeGreaterThan(0.97);
  expect(s.height / a.height).toBeGreaterThan(0.97);
});
