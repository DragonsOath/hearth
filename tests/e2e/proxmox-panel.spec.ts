import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Proxmox VE's panel against the stand-in Proxmox (port 8006), which answers as Proxmox's own API
// code describes: nodes, VMs and containers, storage, backups and tasks, and changes (start, shut
// down, back up, snapshot) through the real plan, approval and read-back code.

let hosts = (Date.now() + 53_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.6`;
};

async function addProxmox(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Proxmox ${run}`,
      kind: "web",
      address: `https://${uniqueHost()}:8006`,
      category: "System",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Proxmox ${run} API token`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "root@pam!e2e=00000000-0000-0000-0000-000000000000",
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
  await expect(pop.getByText(/^done$/i)).toBeVisible({ timeout: 20_000 });
  await pop.getByTestId("approve-here-close").click();
}

const shot = (page: Page, name: string) =>
  page.screenshot({
    path: `test-results/screens/${test.info().project.name === "mobile" ? "mobile" : "desktop"}/${name}.png`,
  });

test.describe("Proxmox VE's panel", () => {
  let id = "";
  test.beforeEach(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addProxmox(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Overview: the node, guests running, backups, failed tasks and storage", async ({
    page,
  }) => {
    const panel = await open(page, id, "overview");
    const board = panel.getByTestId("px-dashboard");
    await expect(board).toBeVisible({ timeout: 20_000 });
    await expect(board.getByTestId("px-node")).toContainText("pve");
    await expect(board.getByTestId("px-node")).toContainText("18.4% of 16 cores");
    await expect(board.getByTestId("px-updates")).toContainText("2 updates waiting");
    await expect(board.getByTestId("px-running")).toHaveText("2 of 3");
    await expect(board.getByTestId("px-backed-up")).toHaveText("2 of 3");
    await expect(board.getByTestId("px-failed")).toHaveText("1");
    await expect(board.getByTestId("px-tasks")).toContainText("job errors");
    await expect(board.getByTestId("px-storage")).toContainText("local-lvm");
    await shot(page, "proxmox-overview");
  });

  test("VMs and containers: start one, back one up, take a snapshot", async ({ page }) => {
    const panel = await open(page, id, "guests");
    const tab = panel.getByTestId("px-guests");
    await expect(tab.getByTestId("px-guest")).toHaveCount(3, { timeout: 20_000 });
    const windows = tab.getByTestId("px-guest").filter({ hasText: "windows" });
    await expect(windows).toHaveAttribute("data-status", "stopped");
    await windows.getByRole("button", { name: "Start" }).click();
    await approve(page, /Start VM 101 \(windows\) on pve/);
    await expect(windows).toHaveAttribute("data-status", "running", { timeout: 15_000 });

    const ha = tab.getByTestId("px-guest").filter({ hasText: "home-assistant" });
    await ha.getByRole("button", { name: /home-assistant/ }).click();
    const detail = ha.getByTestId("px-guest-detail");
    await expect(detail.getByTestId("px-snapshots")).toContainText("before-update", {
      timeout: 15_000,
    });
    await shot(page, "proxmox-guests");
    await detail.getByRole("button", { name: "Back up now" }).click();
    await approve(page, /Back up VM 100 \(home-assistant\) to local now/);
    await detail.getByLabel("Snapshot name").fill("before-upgrade");
    await detail.getByRole("button", { name: "Take a snapshot" }).click();
    await approve(page, /Take a snapshot before-upgrade of VM 100/);
    await expect(detail.getByTestId("px-snapshots")).toContainText("before-upgrade", {
      timeout: 15_000,
    });
  });

  test("Backups: jobs, the newest backup of each guest, and the files", async ({ page }) => {
    const panel = await open(page, id, "backups");
    const tab = panel.getByTestId("px-backups");
    await expect(tab.getByTestId("px-jobs")).toContainText("Every guest to local", {
      timeout: 20_000,
    });
    await expect(tab.getByTestId("px-guest-backups").locator('li[data-stale="yes"]')).toContainText(
      "windows",
    );
    await expect(tab.getByTestId("px-files").locator("li")).toHaveCount(2);
    await expect(tab).toContainText("job errors");
    await shot(page, "proxmox-backups");
  });
});
