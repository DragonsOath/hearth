import { expect, test, type Page } from "@playwright/test";

const OWNER_PASSWORD = "e2e owner password";

// "Open it for me" and page help (FEATURE_CHECKLIST 42.2). The test agent follows Hearth's hint to
// hearth_help and answers with the Open link it gives; the Lair also offers an Open button under
// the answer by itself. Each must land on the real page, section, panel or tab, and nothing opens
// until the owner clicks.

async function ask(page: Page, question: string) {
  await page.goto("/ask");
  await page.locator("textarea").first().fill(question);
  await page.getByRole("button", { name: "Send" }).first().click();
  const answer = page.getByTestId("answer").last();
  await expect(answer).toContainText("(test agent)", { timeout: 30_000 });
  return answer;
}

test("open it for me: Ember's Open buttons reach movie nights, destinations, the vault, Home Assistant and RAID", async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const request = page.request;
  const ws = (await (await request.get("/api/workspace")).json()) as {
    operator: { agentId?: string | null };
  };
  await request.post("/api/agent/providers/claude-code/connect", { data: {} });
  // A Home Assistant this installation watches, so its panel is somewhere to open.
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.123`;
  const made = await request.post("/api/services", {
    data: {
      name: `Home Assistant ${run}`,
      kind: "web",
      address: `http://${host}:8123`,
      category: "Home",
    },
  });
  expect(made.status(), await made.text()).toBe(201);
  const haId = ((await made.json()) as { id: string }).id;
  try {
    // Movie nights: its own panel in the Lair (11-12).
    let answer = await ask(page, "How do I invite friends to a movie night?");
    await expect(answer).toContainText("The Lair: Movie nights");
    // The answer's own link and the button under it go to the same place.
    await expect(answer.getByTestId("answer-open-link")).toHaveAttribute(
      "href",
      /^\/\?panels=tool%3Amovie-nights/,
    );
    await expect(page.getByText("[Open")).toHaveCount(0);
    // Nothing opened by itself.
    await expect(page).toHaveURL(/\/ask/);
    await page.getByTestId("open-feature").filter({ hasText: "Open Movie nights" }).last().click();
    await expect(page).toHaveURL(/panels=tool%3Amovie-nights/);
    await expect(page.getByTestId("movie-nights-panel").first()).toBeVisible({ timeout: 10_000 });

    // Notification destinations: the Channels section, where a bot destination is added.
    answer = await ask(page, "How do I add a Discord bot destination?");
    await page.getByTestId("open-feature").last().click();
    await expect(page).toHaveURL(/\/notifications#channels$/);
    await expect(page.locator("#channels")).toBeInViewport({ timeout: 10_000 });

    // The Secure Vault: its own page. Late in a long run the five-minute unlock has passed, so
    // confirm it's you first, as the owner would.
    await page.request.post("/api/auth/login", { data: { password: OWNER_PASSWORD } });
    await ask(page, "Where is the Secure Vault?");
    await page.getByTestId("open-feature").filter({ hasText: "Open Secure Vault" }).last().click();
    await expect(page).toHaveURL(/\/vault$/);
    await expect(page.getByRole("button", { name: "Add a credential" }).first()).toBeVisible();

    // Home Assistant: the panel of a Home Assistant this installation has (the shared test install
    // may have another one besides ours; the first is opened).
    await ask(page, "How do I run a Home Assistant routine?");
    await page
      .getByTestId("open-feature")
      .filter({ hasText: "Open Home Assistant" })
      .last()
      .click();
    await expect(page.getByTestId("service-workspace").last()).toContainText("Home Assistant");

    // RAID: the Storage & Files panel, on its RAID / Arrays tab.
    await ask(page, "Where can I see my RAID arrays?");
    await page.getByTestId("open-feature").filter({ hasText: "Open RAID / Arrays" }).last().click();
    await expect(page.getByRole("tab", { name: "RAID / Arrays" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // That panel's own "How this works": the RAID feature, in the manual's words.
    const panel = page.locator("section[aria-label='Storage & Files']").last();
    await panel.getByTestId("feature-help").click();
    const sheet = page.getByTestId("feature-help-sheet");
    await expect(sheet.locator("[data-feature='raid']")).toBeVisible();
    await page.keyboard.press("Escape");

    // A page's "How this works": Notifications lists its features, with what is not set up here.
    await page.goto("/notifications");
    // The top bar's button (the phone header has its own; the hidden one is skipped).
    await page.getByTestId("feature-help").filter({ visible: true }).first().click();
    await expect(sheet.locator("[data-feature='media-announcements']")).toContainText(
      "Send a test",
    );
    await expect(sheet.getByRole("link", { name: /Ask .* about this/ }).first()).toBeVisible();
  } finally {
    await request.post(`/api/services/${haId}/remove`, { data: {} });
    if (!ws.operator.agentId) await request.post("/api/agent/disconnect", { data: {} });
  }
});
