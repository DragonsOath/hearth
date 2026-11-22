import { expect, test, type Page } from "@playwright/test";

// Build mode (11-22, the beginner retest): in the build's conversation, every Ember message ends
// with exactly one next action, shown by Hearth under her latest answer. Here: Radarr failed
// Hearth's own check while it runs and answers, so the one action is "it works: continue", and
// once that is approved the next one is Continue. The build's state is a stand-in answer.

let wasConnected = true;
test.beforeEach(async ({ page }) => {
  const ws = (await (await page.request.get("/api/workspace")).json()) as {
    operator: { agentId?: string | null };
  };
  wasConnected = Boolean(ws.operator.agentId);
  await page.request.post("/api/agent/providers/claude-code/connect", { data: {} });
});
test.afterEach(async ({ page }) => {
  if (!wasConnected) await page.request.post("/api/agent/disconnect", { data: {} });
});

const steps = (radarr: Record<string, unknown>) => [
  { id: "docker", name: "Docker", what: "", status: "done" },
  {
    id: "jellyfin",
    name: "Jellyfin",
    what: "",
    status: "done",
    url: "http://homelab:8096",
  },
  { id: "radarr", name: "Radarr", what: "", url: "http://homelab:7878", ...radarr },
  { id: "sonarr", name: "Sonarr", what: "", status: "waiting" },
];

async function stand(page: Page, conversationId: string, radarr: Record<string, unknown>) {
  await page.route("**/api/plan/build", (r) =>
    r.fulfill({
      json: {
        steps: steps(radarr),
        notBuilt: [],
        appsFolder: "/home/alex/hearth-apps",
        conversationId,
        passwords: "own",
        username: "alex",
        ...(radarr.status === "done" ? { next: "sonarr" } : {}),
      },
    }),
  );
}

test("every Ember message in a build ends with one next action, and a false failure has a way past", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const made = await page.request.post("/api/agent/conversations", {
    data: { text: "Let's build my homelab plan." },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const { conversationId } = (await made.json()) as { conversationId: string };
  let confirmed = "";
  await page.route("**/api/plan/build/confirm", async (r) => {
    confirmed = (r.request().postDataJSON() as { step: string }).step;
    return r.fulfill({ json: { id: "j-confirm", status: "awaiting-approval", steps: [] } });
  });
  await stand(page, conversationId, {
    status: "failed",
    answering: true,
    detail: "radarr did not keep the sign-in it was given.",
  });
  await page.goto(`/ask/${conversationId}`);
  const thread = page.getByTestId("cave-thread");
  await expect(thread.getByTestId("answer").last()).toBeVisible({ timeout: 30_000 });
  const next = thread.getByTestId("build-next-action");
  await expect(next).toHaveCount(1);
  await expect(next).toHaveAttribute("data-kind", "confirm");
  // The app set up before it, ready to open, and how to sign in.
  await expect(next).toContainText("Jellyfin is ready.");
  await expect(next).toContainText(
    "Sign in with the username and password you saved at the start.",
  );
  await expect(next.getByRole("button", { name: "Open Jellyfin" })).toBeVisible();
  await next.screenshot({
    path: `test-results/screens/${testInfo.project.name}/build-next-confirm.png`,
  });
  await next.getByTestId("build-confirm").click();
  await expect.poll(() => confirmed).toBe("radarr");

  // Confirmed and done: the one next action is Continue to Sonarr.
  await page.unroute("**/api/plan/build");
  await stand(page, conversationId, { status: "done" });
  await page.reload();
  await expect(thread.getByTestId("build-next-action")).toHaveAttribute("data-kind", "continue", {
    timeout: 20_000,
  });
  await expect(thread.getByTestId("build-continue")).toHaveText("Continue: set up Sonarr");
  await expect(thread.getByTestId("build-next-action")).toContainText(
    "Ready to continue with Sonarr?",
  );

  // A new chat starts where the build left off, from the saved plan.
  await page.goto("/ask");
  const fresh = page.getByTestId("cave-thread").getByTestId("build-next-action");
  await expect(fresh).toContainText("Your build, where it left off", { timeout: 20_000 });
  await expect(fresh.getByTestId("build-where")).toContainText("Done: Docker, Jellyfin, Radarr.");
  await expect(fresh).toContainText("Ready to continue with Sonarr?");
});
