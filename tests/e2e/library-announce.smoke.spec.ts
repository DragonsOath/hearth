import http from "node:http";
import type { AddressInfo } from "node:net";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// New in your library, beyond movies and shows: an Audiobookshelf (a stand-in, DC_FAKE_APPS, port
// 13378) offers Audiobooks in the designer, its back catalog is never announced, and a new
// audiobook reaches the friends destination with its author, narrator and Ember's line on top.
// Each destination can have its own kinds and tone.

test("new in your library: an audiobook arrives with Ember's line, per destination", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const request = page.request;
  const received: { title: string; message: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const hook = `http://127.0.0.1:${(server.address() as AddressInfo).port}/library`;
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.78`;
  const before = (await (await request.get("/api/media-announce")).json()) as {
    settings: Record<string, unknown>;
  };
  let serviceId = "";
  let channelId = "";
  try {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    const made = await request.post("/api/services", {
      data: {
        name: `Audiobookshelf ${run}`,
        kind: "web",
        address: `http://${host}:13378`,
        category: "Media",
      },
    });
    expect(made.status(), await made.text()).toBe(201);
    serviceId = ((await made.json()) as { id: string }).id;
    await request.post("/api/vault/secrets", {
      data: {
        name: `Audiobookshelf ${run} key`,
        kind: "api-key",
        tier: "automation",
        scope: "read",
        serviceId,
        value: "e2e-abs-key",
      },
    });
    channelId = (
      (await (
        await request.post("/api/notifications/destinations", {
          data: { kind: "webhook", name: `Book club ${run}`, audience: "public" },
        })
      ).json()) as { id: string }
    ).id;
    await request.put(`/api/notifications/channels/${channelId}`, {
      data: { values: { url: hook } },
    });
    await request.put("/api/notifications/routes/media-arrivals", {
      data: { channels: [channelId] },
    });
    await request.put("/api/media-announce", {
      data: { ...before.settings, mode: "immediate", quietHours: false, tone: "playful" },
    });

    await page.goto("/notifications");
    const panel = page.getByTestId("media-announcements");
    await panel.scrollIntoViewIfNeeded();
    await expect(panel).toContainText(`Audiobookshelf ${run}`);
    // Only kinds an installed app can supply are offered, and they start off.
    const more = panel.getByTestId("announce-library-kinds");
    await expect(more.getByLabel("Audiobooks")).not.toBeChecked();
    await expect(more.getByLabel("Podcast episodes")).toBeVisible();
    await more.getByLabel("Audiobooks").check();
    await expect(panel.getByTestId("announce-kinds-summary")).toContainText("audiobooks");
    await panel.getByTestId("announce-save").click();
    await expect(panel.getByTestId("announce-save")).toHaveText("Saved");

    // The first check notes the back catalog: nothing is announced for it.
    const sentBefore = received.length;
    await panel.getByTestId("announce-check").click();
    await expect(panel.getByTestId("announce-check")).toHaveText("Check now", { timeout: 30_000 });
    expect(received.length).toBe(sentBefore);

    // A new audiobook goes out once, with its author and the line on top.
    const title = `The Long Night Road ${run}`;
    await request.post("/api/test/fake-apps", { data: { absArrival: title } });
    await panel.getByTestId("announce-check").click();
    const history = panel.getByTestId("announce-history");
    await expect(history).toContainText(title, { timeout: 20_000 });
    await expect(history).toContainText(/sent/);
    const post = received.slice(sentBefore).find((r) => r.title.includes(title));
    expect(post?.title).toContain(`New audiobook: ${title} by Sample Author`);
    expect(post?.message ?? "").toMatch(/^\S[^:\n]{0,40}: \S/);
    expect(received.map((r) => r.title).join(" ")).not.toContain("Project Hail Mary");

    // The preview is the real card, with the line in the chosen destination's tone.
    await panel.getByRole("tab", { name: /^Audiobooks/ }).click();
    await panel.getByLabel("Preview with").selectOption({ label: title });
    await expect(panel.getByTestId("announce-preview-title")).toContainText("by Sample Author");
    // The line is the card's top line, signed with the AI's name ("Ember:", or whatever this
    // Hearth calls it), with Messenger Ember beside it.
    const preview = panel.getByTestId("announce-preview");
    const ember = preview.getByTestId("announce-preview-ember");
    await expect(ember).toBeVisible();
    const top = (await ember.locator("xpath=..").textContent())?.trim() ?? "";
    const signed = /^[^:]{1,40}:/.exec(top)?.[0] ?? "";
    expect(signed).toMatch(/^\S.*:$/);
    await preview.screenshot({
      path: `test-results/screens/${testInfo.project.name}/announce-preview-ember.png`,
    });
    // Tone Off for this destination: its preview has no line.
    const custom = panel.getByTestId("announce-customize");
    await custom.locator("summary").click();
    await custom.getByLabel(new RegExp(`^Book club ${run}: .*line`)).selectOption("off");
    await panel.getByLabel("Test destination").selectOption({ label: `Book club ${run}` });
    await expect(preview).not.toContainText(signed);
    await expect(ember).toHaveCount(0);
    await expect(preview).toContainText("by Sample Author");
    expect(
      await new AxeBuilder({ page }).include('[data-testid="media-announcements"]').analyze(),
    ).toMatchObject({ violations: [] });
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/library-announcements.png`,
      fullPage: true,
    });
  } finally {
    await request.put("/api/notifications/routes/media-arrivals", { data: { channels: [] } });
    if (channelId) await request.delete(`/api/notifications/channels/${channelId}`);
    if (serviceId) await request.post(`/api/services/${serviceId}/remove`, { data: {} });
    await request.put("/api/media-announce", { data: before.settings });
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    server.close();
  }
});
