import { expect, test, type Locator, type Page } from "@playwright/test";

// A laptop screen (11-22, the owner: "I always had to scroll a bit to get to the approve button.
// I had to scroll to get to the hide button on the plan"). A long plan sliding in on any page
// keeps Close at the top and Approve in view, its steps scrolling inside the card; the plan
// wizard keeps Back and Next on screen. The plan is a stand-in answer.

test.use({
  viewport: { width: 1280, height: 720 },
  // Real scrollbars, as on a laptop (headless Chrome hides them by default).
  launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
});

const steps = Array.from({ length: 14 }, (_, i) => ({
  seq: i + 1,
  label: `Set up app number ${i + 1} and check it answers`,
  serviceName: "Docker",
  changes: true,
  policy: "approve-first",
  policyReason: "",
  verify: "",
  rollback: "",
  status: "planned",
}));
const job = {
  id: "job-laptop-fit",
  title: "Build the rest of your homelab",
  reason: "You asked for movies, shows and requests.",
  impact: "Fourteen apps are set up and connected.",
  requestedBy: "agent",
  status: "awaiting-approval",
  createdAt: new Date().toISOString(),
  approval: { fingerprint: "f", expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  steps,
};

async function inView(page: Page, l: Locator) {
  const box = await l.boundingBox();
  const vp = page.viewportSize()!;
  expect(box, "on the page").not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height);
}

test("a long plan fits a laptop screen: Close at the top, Approve in view", async ({
  page,
}, testInfo) => {
  await page.route("**/api/jobs", (r) => r.fulfill({ json: [job] }));
  await page.route("**/api/jobs/job-laptop-fit", (r) => r.fulfill({ json: job }));
  await page.goto("/settings");
  const dock = page.getByTestId("approval-dock");
  await expect(dock).toBeVisible({ timeout: 15_000 });
  const approve = dock.getByRole("button", { name: "Approve and run" });
  const later = dock.getByTestId("approval-dock-later");
  await expect(approve).toBeVisible();
  // Both on screen without scrolling the page or the prompt.
  await inView(page, approve);
  await inView(page, later);
  const outer = await dock.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(outer).toBeLessThanOrEqual(1);
  // Close is above the plan, not under it.
  expect((await later.boundingBox())!.y).toBeLessThan((await approve.boundingBox())!.y);
  // The steps scroll inside the card.
  const list = dock.getByTestId("job-steps");
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/laptop-approval.png`,
  });
  await later.click();
  await expect(dock).toHaveCount(0);
});

test("the plan wizard keeps Back and Next on a laptop screen", async ({ page }) => {
  await page.goto("/plan?step=1");
  const nav = page.getByRole("navigation", { name: "Plan steps" });
  await expect(nav.getByRole("button", { name: "Back" })).toBeVisible({ timeout: 15_000 });
  await inView(page, nav.getByRole("button", { name: "Back" }));
});

test("a page that scrolls has a bar wide enough to grab and drag", async ({ page }, testInfo) => {
  await page.goto("/settings");
  const main = page.locator("main").first();
  await expect(main).toBeVisible({ timeout: 15_000 });
  const bar = await main.evaluate((el) => {
    const e = el as HTMLElement;
    return { scrolls: e.scrollHeight > e.clientHeight, width: e.offsetWidth - e.clientWidth };
  });
  expect(bar.scrolls).toBe(true);
  expect(bar.width).toBeGreaterThanOrEqual(12);
  // Grab the bar near the top and drag it down: the page moves.
  const box = (await main.boundingBox())!;
  const x = box.x + box.width - 7;
  await page.mouse.move(x, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(x, box.y + 300, { steps: 8 });
  await page.mouse.up();
  expect(await main.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/laptop-scrollbar.png`,
  });
});
