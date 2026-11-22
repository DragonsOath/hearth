import { expect, test } from "@playwright/test";

// A new Hearth is out: the top bar's Update button, the bell, the card on the page the bell
// opens, and Settings, About. GitHub is replaced by a stand-in answer here.
const state = (over: Record<string, unknown> = {}) => ({
  current: "0.31.0",
  latest: { version: "0.32.0", notes: "Faster War Room.\nNew icons.", url: "https://example.com" },
  available: true,
  checkedAt: new Date().toISOString(),
  problem: null,
  canUpdate: true,
  cannot: null,
  commands: {
    linux: "gh api repos/x/contents/deploy/get.sh | bash",
    windows: "gh api repos/x/contents/deploy/get.ps1 | Invoke-Expression",
  },
  updating: false,
  ...over,
});

test("a new Hearth: Update in the top bar, on the bell, and in Settings; Update now", async ({
  page,
}) => {
  let installed = false;
  await page.route("**/api/updates", (r) => r.fulfill({ json: state({ updating: installed }) }));
  await page.route("**/api/updates/install", (r) => {
    installed = true;
    return r.fulfill({ json: { ok: true, message: "Updating." } });
  });

  await page.goto("/");
  const button = page.getByTestId("update-button");
  await expect(button).toBeVisible();
  // The bell counts it too, and its page shows it first.
  await expect(page.getByTestId("bell")).toHaveAccessibleName(/need you/);
  await page.goto("/incidents");
  await expect(page.getByTestId("update-card")).toContainText("Hearth 0.32.0 is out");

  await page.getByTestId("update-button").click();
  const sheet = page.getByRole("dialog", { name: "Update Hearth" });
  await expect(sheet).toContainText("Faster War Room.");
  await expect(sheet).toContainText("version 0.31.0");
  // The command to run by hand is there too.
  await expect(sheet.locator("code")).toContainText("deploy/get.");
  await sheet.getByTestId("update-now").click();
  await expect(sheet.getByTestId("update-running")).toContainText("Updating");
  expect(installed).toBe(true);
  await sheet.getByRole("button", { name: "Close" }).click();

  await page.goto("/settings#about");
  await expect(page.getByRole("region", { name: "Updates" })).toContainText("0.32.0 is out");
});

test("no update: nothing in the top bar; Settings says it is the newest", async ({ page }) => {
  await page.route("**/api/updates", (r) =>
    r.fulfill({
      json: state({
        current: "0.32.0",
        available: false,
      }),
    }),
  );
  await page.goto("/settings#about");
  const updates = page.getByRole("region", { name: "Updates" });
  await expect(updates).toContainText("It is the newest");
  await expect(page.getByTestId("update-button")).toHaveCount(0);
  // Checking again is a real button, easy to find (11-10).
  await expect(updates.getByRole("button", { name: "Check for updates" })).toBeVisible();
});

test("release channel: stable by default, fast when chosen, saved on the server", async ({
  page,
}, testInfo) => {
  let channel = "stable";
  await page.route("**/api/updates", (r) =>
    r.fulfill({ json: state({ current: "0.32.0", available: false, channel }) }),
  );
  await page.route("**/api/updates/channel", async (r) => {
    channel = (r.request().postDataJSON() as { channel: string }).channel;
    return r.fulfill({ json: state({ current: "0.32.0", available: false, channel }) });
  });
  await page.goto("/settings#about");
  const picker = page.getByRole("radiogroup", { name: "Release channel" });
  await expect(picker.getByRole("radio", { name: "Stable" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByTestId("update-channel")).toContainText("only releases marked stable");
  await picker.getByRole("radio", { name: "Fast" }).click();
  await expect(picker.getByRole("radio", { name: "Fast" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("update-channel")).toContainText("as soon as it is out");
  expect(channel).toBe("fast");
  await page.getByRole("region", { name: "Updates" }).screenshot({
    path: `test-results/screens/${testInfo.project.name}/updates-channel.png`,
  });
});
