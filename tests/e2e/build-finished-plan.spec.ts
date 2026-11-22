import { expect, test } from "@playwright/test";

// The build is finished (11-22, the owner: "have Ember say congratulations, everything is built.
// I got nothing"). On any page, once: the congratulations, what was built, and Open for the
// media app; Close says so to the server. The build's state is a stand-in answer.

const done = (id: string, name: string) => ({ id, name, what: "", status: "done" });

test("a finished build congratulates them on any page, once", async ({ page }, testInfo) => {
  let closed = false;
  await page.route("**/api/plan/build/celebrated", (r) => {
    closed = true;
    return r.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/plan/build", (r) =>
    r.fulfill({
      json: {
        steps: [
          done("docker", "Docker"),
          { ...done("jellyfin", "Jellyfin"), url: "http://localhost:8096" },
          done("seerr", "Seerr"),
          done("radarr", "Radarr"),
          done("sonarr", "Sonarr"),
        ],
        notBuilt: [],
        appsFolder: "/home/sam/hearth-apps",
        done: true,
        finishedAt: new Date().toISOString(),
        ...(closed ? { celebrated: true } : {}),
      },
    }),
  );
  await page.goto("/");
  const card = page.getByRole("dialog", { name: "Congratulations, everything is built!" });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("Jellyfin, Seerr, Radarr and Sonarr");
  await expect(card.getByRole("button", { name: "Open Jellyfin" })).toBeVisible();
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/build-finished.png`,
  });
  await card.getByRole("button", { name: "Close" }).click();
  await expect(card).toHaveCount(0);
  expect(closed).toBe(true);
  await page.reload();
  await expect(page.getByTestId("build-finished")).toHaveCount(0);
});
