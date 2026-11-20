import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Paperless-ngx's panel against the stand-in Paperless-ngx (port 8000, answering as a real 3.4.2
// did): the inbox, a failed import, its health and tags, and changes through the real plan,
// approval and read-back code. Document text, the token and Redis's address never reach the page.

const OWNER_PASSWORD = "e2e owner password";
const PAPERLESS_TOKEN = "e2e-paperless-token";

let hosts = (Date.now() + 53_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.95`;
};

async function addPaperless(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Paperless-ngx ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:8000`,
      category: "Files & Photos",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Paperless-ngx ${run} token`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: PAPERLESS_TOKEN,
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

test.describe("Paperless-ngx's panel", () => {
  let id = "";
  test.beforeEach(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addPaperless(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Overview: inbox, failed import, health and tags", async ({ page }) => {
    const panel = await open(page, id, "overview");
    const d = panel.getByTestId("pl-dashboard");
    await expect(d).toBeVisible({ timeout: 30_000 });
    await expect(d.getByTestId("pl-inbox")).toHaveText("3");
    await expect(d.getByTestId("pl-waiting")).toHaveText("1");
    await expect(d.getByTestId("pl-failed")).toHaveText("1");
    await expect(d.getByTestId("pl-documents")).toHaveText("5");
    const failure = d.getByTestId("pl-failure");
    await expect(failure).toContainText("scan-0042.pdf");
    await expect(failure).toContainText("InputFileError");
    await expect(d.getByTestId("pl-importing")).toContainText("receipt-hardware-store.jpg");
    await expect(d.getByTestId("pl-health")).toContainText(
      "Classifier: Classifier file does not exist",
    );
    await expect(d.getByTestId("pl-tags")).toContainText("Bills");
    const body = page.locator("body");
    await expect(body).not.toContainText("e2e-SECRET");
    await expect(body).not.toContainText("redis://");
    await expect(body).not.toContainText(PAPERLESS_TOKEN);
    await shot(page, "paperless-overview");

    await failure.getByTestId("pl-dismiss").click();
    await approve(page, /Dismiss the failed import of scan-0042.pdf/);
    await expect(d.getByTestId("pl-failed")).toHaveText("0", { timeout: 20_000 });
  });

  test("Inbox: mark documents done through a plan", async ({ page }) => {
    const panel = await open(page, id, "inbox");
    const tab = panel.getByTestId("pl-inbox-tab");
    await expect(tab.getByTestId("pl-doc")).toHaveCount(3, { timeout: 30_000 });
    await expect(tab.getByTestId("pl-doc").first()).toContainText("Electricity bill November");
    await expect(tab.getByTestId("pl-doc").first()).toContainText("Acme Power");
    await expect(tab.getByTestId("pl-mark-done")).toBeDisabled();
    await shot(page, "paperless-inbox");
    await tab.getByRole("checkbox", { name: "Select Electricity bill November" }).check();
    await tab.getByRole("checkbox", { name: "Select Letter from the school" }).check();
    await tab.getByTestId("pl-mark-done").click();
    await approve(page, /Mark 2 documents done/);
    await expect(tab.getByTestId("pl-doc")).toHaveCount(1, { timeout: 20_000 });
    await expect(tab.getByTestId("pl-doc")).toContainText("Water bill October");
  });

  test("Documents: search, move to the trash and bring back", async ({ page }) => {
    const panel = await open(page, id, "documents");
    const tab = panel.getByTestId("pl-documents-tab");
    await expect(tab.getByTestId("pl-doc")).toHaveCount(5, { timeout: 30_000 });
    await tab.getByPlaceholder("Search every document's text").fill("insurance");
    await tab.getByRole("button", { name: "Search", exact: true }).click();
    await expect(tab.getByTestId("pl-doc")).toHaveCount(1);
    await expect(tab.getByTestId("pl-doc-count")).toContainText('1 found for "insurance"');
    await tab.getByRole("checkbox", { name: "Select Car insurance renewal" }).check();
    await tab.getByTestId("pl-trash").click();
    await approve(page, /Move "Car insurance renewal" to .*trash/);
    await expect(tab.getByTestId("pl-doc")).toHaveCount(0, { timeout: 20_000 });
    await tab.getByTestId("pl-trash-toggle").click();
    await expect(tab.getByTestId("pl-doc")).toHaveCount(1);
    await expect(tab.getByTestId("pl-doc")).toContainText("in the trash since");
    await shot(page, "paperless-trash");
    await tab.getByRole("checkbox", { name: "Select Car insurance renewal" }).check();
    await tab.getByTestId("pl-restore").click();
    await approve(page, /Bring "Car insurance renewal" back/);
    await expect(tab.getByTestId("pl-doc")).toHaveCount(0, { timeout: 20_000 });
  });
});
