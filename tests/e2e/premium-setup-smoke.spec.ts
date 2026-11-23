import { expect, test } from "@playwright/test";

// Premium turning on (11-22, launch-critical: a redeemed Reviewers code unlocked nothing). After a
// redeem, every page says where the Premium package stands; once Hearth has reloaded with it,
// "Welcome to Premium" shows once. The server's answers are stand-ins here.

const features = ["hearth_interconnectivity", "ember_show_and_tell", "panel_builder"].map(
  (feature) => ({ feature, state: "active", kind: "complimentary" }),
);
const base = {
  installId: "install-1",
  features,
  issuer: false,
  redeemOnline: true,
  licenses: [],
};

test("waiting for a running job, then Welcome to Premium once", async ({ page }, testInfo) => {
  let stage: "waiting" | "ready" = "waiting";
  let welcomed = false;
  await page.route("**/api/premium/welcomed", (r) => {
    welcomed = true;
    return r.fulfill({ json: { ...base, package: { state: "ready", version: "1.0.0" } } });
  });
  await page.route("**/api/premium", (r) =>
    r.fulfill({
      json:
        stage === "waiting"
          ? {
              ...base,
              package: {
                state: "waiting",
                version: "1.0.0",
                busy: ["a job or build step running"],
              },
            }
          : {
              ...base,
              package: { state: "ready", version: "1.0.0" },
              ...(welcomed ? {} : { welcome: true }),
            },
    }),
  );
  await page.goto("/settings");
  const banner = page.getByTestId("premium-setup");
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText(
    "Premium is installed. Hearth reloads to turn it on once this is done: a job or build step running.",
  );
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/premium-setup-waiting.png`,
  });

  // Hearth came back with the package: the welcome, with every extra it turned on.
  stage = "ready";
  await page.reload();
  const dialog = page.getByRole("dialog", { name: "Welcome to Premium" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog).toContainText("Hearth Connected");
  await expect(dialog).toContainText("Ember Show & Tell");
  await expect(dialog).toContainText("Panel Builder");
  await expect(page.getByTestId("premium-setup")).toHaveCount(0);
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/premium-welcome.png`,
  });
  await dialog.getByRole("button", { name: "Let's go" }).click();
  await expect(dialog).toHaveCount(0);
  expect(welcomed).toBe(true);
  await page.reload();
  await expect(page.getByTestId("premium-welcome")).toHaveCount(0);
});
