import { expect, test } from "@playwright/test";

// "Do it on the plan page" (11-22, the owner: "it makes me go through the whole setup again").
// The link opens the build's own page at that step, not the plan's first question. The build's
// state is a stand-in answer; the plan and accounts are saved on the real server.

test.beforeEach(async ({ page }) => {
  await page.request.delete("/api/plan");
  await page.request.post("/api/plan/scan", { data: {} });
  await page.request.put("/api/plan", {
    data: { answers: { wants: ["watch", "request"], devices: [] }, removed: [], confirmed: true },
  });
  await page.request.put("/api/plan/accounts", {
    data: { email: "sam@example.com", username: "sam", passwords: "generate" },
  });
});

const done = (id: string, name: string) => ({ id, name, what: "", status: "done" });

test("a link to a step opens the build page on that step", async ({ page }, testInfo) => {
  await page.route("**/api/plan/build", (r) =>
    r.fulfill({
      json: {
        notBuilt: [],
        appsFolder: "/home/sam/hearth-apps",
        done: false,
        steps: [
          done("docker", "Docker"),
          done("jellyfin", "Jellyfin"),
          done("seerr", "Seerr"),
          done("radarr", "Radarr"),
          done("sonarr", "Sonarr"),
          done("prowlarr", "Prowlarr"),
          done("qbittorrent", "qBittorrent with your VPN"),
          done("connect", "Connect the apps"),
          {
            id: "tailscale",
            name: "Tailscale",
            what: "",
            status: "needs-you",
            detail: "Installed. Sign in to Tailscale to connect this computer.",
            need: { kind: "tailscale-login" },
          },
        ],
      },
    }),
  );
  await page.goto("/plan?step=build#build-step-tailscale");
  // Not the first question of the plan.
  await expect(page.getByText("Step 1 of")).toHaveCount(0);
  const step = page.getByTestId("build-step-tailscale");
  await expect(step).toBeVisible({ timeout: 15_000 });
  await expect(step).toBeInViewport();
  await expect(step).toBeFocused();
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/step-link.png`,
  });
});
