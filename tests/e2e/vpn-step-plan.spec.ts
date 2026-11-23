import { expect, test } from "@playwright/test";

// The VPN step (11-22, the laptop retest): a beginner could not get qBittorrent past the VPN.
// The form says it is not the Proton sign-in, uses Proton's own labels and opens its page, keeps
// the browser's saved login out, and an email is refused with the reason. A refused login says
// so plainly on the step. The build's state is a stand-in answer; saving goes to the real server.

test.beforeEach(async ({ page }) => {
  await page.request.delete("/api/plan");
  await page.request.post("/api/plan/scan", { data: {} });
  await page.request.put("/api/plan", {
    data: { answers: { wants: ["watch", "request"], devices: [] }, removed: [], confirmed: true },
  });
  await page.request.put("/api/plan/accounts", {
    data: {
      email: "sam@example.com",
      username: "sam",
      passwords: "own",
      password: "correct horse battery staple",
    },
  });
});

const base = {
  notBuilt: [],
  appsFolder: "/home/sam/hearth-apps",
  downloads: { setUp: false, wanted: true, vpn: "proton", keepItFree: false },
};
const done = (id: string, name: string) => ({ id, name, what: "", status: "done" });

test("the VPN login: not the Proton sign-in, Proton's labels and page, no browser fill, an email refused", async ({
  page,
}, testInfo) => {
  await page.route("**/api/plan/build", (r) =>
    r.fulfill({
      json: {
        ...base,
        steps: [
          done("docker", "Docker"),
          done("jellyfin", "Jellyfin"),
          {
            id: "qbittorrent",
            name: "qBittorrent with your VPN",
            what: "Downloads, only through your VPN.",
            status: "needs-you",
            need: { kind: "vpn-login", provider: "proton" },
          },
        ],
      },
    }),
  );
  await page.goto("/plan?step=7");
  const form = page.getByRole("form", { name: "Your VPN login" });
  await expect(form).toBeVisible();
  // Asked once, before the Build button (11-22), not again in the steps below it.
  await expect(form).toHaveCount(1);
  // Build it with the AI (or, with no AI connected here, the way to connect one).
  const build = page.getByTestId(/^build-(start|needs-ai)$/);
  await expect(build).toBeVisible();
  expect((await form.boundingBox())!.y).toBeLessThan((await build.boundingBox())!.y);
  await expect(page.getByTestId("build-progress").getByRole("form")).toHaveCount(0);
  const where = form.getByTestId("vpn-login-where");
  await expect(where).toContainText("not the username and password you sign in to Proton VPN with");
  await expect(where.getByRole("link", { name: "Open Proton VPN's page for it" })).toHaveAttribute(
    "href",
    "https://account.proton.me/vpn/OpenVpnIKEv2",
  );
  await expect(form.getByLabel("OpenVPN / IKEv2 username")).toBeVisible();
  await expect(form.getByLabel("OpenVPN / IKEv2 password")).toBeVisible();
  // Password managers and the browser keep their saved logins out of these boxes.
  await expect(form.getByTestId("vpn-pass")).toHaveAttribute("autocomplete", "new-password");
  await expect(form.getByTestId("vpn-user")).toHaveAttribute("data-1p-ignore", "");
  await form.screenshot({ path: `test-results/screens/${testInfo.project.name}/vpn-1-form.png` });

  // The account email instead of the VPN's own pair: refused at once, with the reason.
  await form.getByTestId("vpn-user").fill("sam@example.com");
  await form.getByTestId("vpn-pass").fill("my-proton-password");
  await form.getByRole("button", { name: "Save my VPN login" }).click();
  await expect(form).toContainText("That looks like your Proton VPN account email.");
  await form.screenshot({ path: `test-results/screens/${testInfo.project.name}/vpn-2-email.png` });
});

test("a refused VPN login says so plainly on the step, and where the right pair is", async ({
  page,
}, testInfo) => {
  await page.route("**/api/plan/build", (r) =>
    r.fulfill({
      json: {
        ...base,
        steps: [
          done("docker", "Docker"),
          done("jellyfin", "Jellyfin"),
          {
            id: "qbittorrent",
            name: "qBittorrent with your VPN",
            what: "Downloads, only through your VPN.",
            status: "failed",
            jobId: "job-1",
            detail:
              'Proton VPN turned down the VPN login, so qBittorrent was not started (nothing downloads without the VPN). Proton VPN\'s VPN connections use their own username and password, a separate pair from the one you sign in to Proton VPN with: the "OpenVPN / IKEv2 username" and "OpenVPN / IKEv2 password" on that page (https://account.proton.me/vpn/OpenVpnIKEv2). Put that pair in "Your VPN login" on the plan page, and Hearth tries again.',
          },
        ],
      },
    }),
  );
  await page.goto("/plan?step=7");
  const step = page.getByTestId("build-step-qbittorrent");
  await expect(step).toContainText("Proton VPN turned down the VPN login");
  await expect(step).not.toContainText("Container gluetun");
  // The way past, right on the step: the VPN login form, with Proton's page.
  const form = step.getByRole("form", { name: "Your VPN login" });
  await expect(form).toBeVisible();
  await expect(form.getByRole("link", { name: "Open Proton VPN's page for it" })).toBeVisible();
  await page.getByTestId("build-progress").screenshot({
    path: `test-results/screens/${testInfo.project.name}/vpn-3-refused.png`,
  });
});
