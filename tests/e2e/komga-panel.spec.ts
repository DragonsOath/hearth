import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Komga's panel against the stand-in Komga (port 25600, answering as a real 1.30.0 did): books,
// libraries and a scan read back by the book count, a broken book read again, and failed sign-ins,
// through the real plan, approval and read-back code. The API key never reaches the page.

const OWNER_PASSWORD = "e2e owner password";
const KEY = "e2e-komga-SECRET-key";

let hosts = (Date.now() + 71_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.89`;
};

async function addKomga(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Komga ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:25600`,
      category: "Media",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Komga ${run} key`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: KEY,
    },
  });
  return id;
}

async function open(page: Page, id: string, tab: string) {
  await page.goto(`/?panels=${encodeURIComponent(`service:${id}@${tab}`)}`);
  const panel =
    test.info().project.name === "mobile"
      ? page.getByTestId("service-workspace")
      : page.locator(`[data-panel="service:${id}"]`);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  return panel;
}

async function approve(page: Page, says: RegExp) {
  const pop = page.getByTestId("approve-here");
  await expect(pop).toBeVisible({ timeout: 15_000 });
  await expect(pop).toContainText(says);
  await pop.getByTestId("approve-here-approve").click();
  const confirm = pop.getByTestId("approve-confirm");
  const done = pop.getByText(/^done$/i);
  await expect(confirm.or(done).first()).toBeVisible({ timeout: 30_000 });
  if (await confirm.isVisible()) {
    await confirm.getByPlaceholder("Password").fill(OWNER_PASSWORD);
    await confirm.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(done).toBeVisible({ timeout: 30_000 });
  }
  await pop.getByTestId("approve-here-close").click();
}

const shot = (page: Page, name: string) =>
  page.screenshot({
    path: `test-results/screens/${test.info().project.name === "mobile" ? "mobile" : "desktop"}/${name}.png`,
  });

test.describe("Komga's panel", () => {
  let id = "";
  test.beforeEach(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addKomga(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Overview: books, unreadable, libraries and a scan through a plan", async ({ page }) => {
    const panel = await open(page, id, "overview");
    const d = panel.getByTestId("km-dashboard");
    await expect(d).toBeVisible({ timeout: 30_000 });
    await expect(d.getByTestId("km-books")).toHaveText("642");
    await expect(d.getByTestId("km-unreadable")).toHaveText("1");
    await expect(d.getByTestId("km-failed")).toHaveText("6");
    await expect(d.getByTestId("km-library")).toHaveCount(2);
    await expect(d.getByTestId("km-library").first()).toContainText("scans every 6 hours");
    await expect(d.getByTestId("km-latest")).toContainText("Lantern Tales v04");
    await expect(page.locator("body")).not.toContainText("SECRET");
    await shot(page, "komga-overview");
    await d.getByTestId("km-library").filter({ hasText: "Comics" }).getByTestId("km-scan").click();
    await approve(page, /Scan the Comics library/);
    await expect(d.getByTestId("km-books")).toHaveText("643", { timeout: 20_000 });
  });

  test("Books and People: read a broken book again, failed sign-ins", async ({ page }) => {
    const panel = await open(page, id, "people");
    const people = panel.getByTestId("km-people-tab");
    await expect(people.getByTestId("km-user")).toHaveCount(2, { timeout: 30_000 });
    await expect(people.getByTestId("km-user").first()).toContainText("administrator");
    await expect(people.getByTestId("km-failed-list")).toContainText("203.0.113.9");
    await shot(page, "komga-people");
    const books = (await open(page, id, "books")).getByTestId("km-books-tab");
    const bad = books.getByTestId("km-bad-book");
    await expect(bad).toContainText("Harbor Lights v03", { timeout: 30_000 });
    await expect(bad).toContainText("ERR_1002");
    await shot(page, "komga-books");
    await bad.getByTestId("km-read-again").click();
    await approve(page, /Harbor Lights v03/);
    await expect(books).toContainText("Komga can open every book.", { timeout: 20_000 });
  });
});
