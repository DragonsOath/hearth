import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";

// Briefs and watches (11-13, Talome Gap Plan item 3): set up in Notifications, sent now to a
// channel, switched off and removed. They only read and tell.

test("Briefs and watches: add a morning summary, send it now, switch it off and remove it", async ({
  page,
}) => {
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
  const hook = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  try {
    const setUp = await page.request.put("/api/notifications/channels/webhook", {
      data: { values: { url: hook } },
    });
    expect(setUp.status(), await setUp.text()).toBe(204);
    // Start clean: earlier runs of this test may have left briefs.
    const before = (await (await page.request.get("/api/briefs")).json()) as {
      briefs: { id: string }[];
    };
    for (const b of before.briefs) await page.request.delete(`/api/briefs/${b.id}`);

    await page.goto("/notifications#briefs");
    const box = page.getByTestId("briefs");
    await expect(box).toContainText("None yet.");
    await box.getByTestId("add-brief").click();
    const form = page.getByRole("form", { name: "Add a brief or watch" });
    await form.getByRole("button", { name: "Webhook" }).click();
    await form.getByRole("button", { name: "Add" }).click();
    const row = box.getByTestId("brief");
    await expect(row).toContainText("A server summary, weekdays at 7:00 AM.");

    // Changed in place, not removed and added again (11-13).
    await row.getByRole("button", { name: /^Change/ }).click();
    const changing = page.getByRole("form", { name: /^Change / });
    await changing.getByLabel("Time").fill("08:30");
    await changing.getByRole("button", { name: "Save" }).click();
    await expect(row).toContainText("A server summary, weekdays at 8:30 AM.");

    await row.getByRole("button", { name: "Send now" }).click();
    await expect(row.getByRole("status")).toHaveText("Sent.");
    await expect.poll(() => received.map((r) => r.title)).toContain("Home: your summary");

    await row.getByRole("switch").click();
    await expect(row.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    await row.getByRole("button", { name: /^Remove/ }).click();
    await expect(box).toContainText("None yet.");
  } finally {
    server.close();
  }
});

test("Telegram and browser push are offered on Notifications", async ({ page }) => {
  await page.goto("/notifications");
  // Telegram: one field, the bot token, with how to get one.
  const tg = page.getByTestId("channel-telegram");
  await tg.getByRole("button", { name: "Set up" }).click();
  const sheet = page.getByRole("dialog", { name: "Set up Telegram" });
  await expect(sheet.getByLabel("Bot token")).toBeVisible();
  await expect(sheet).toContainText("@BotFather");
  await page.keyboard.press("Escape");
  // Browser push: turned on from this device, or, where the browser can't (these tests block
  // service workers), it says what is needed instead of a dead button.
  const push = page.getByTestId("channel-push");
  await expect(push.getByTestId("push-setup")).toContainText(
    /Turn (on|off) for this device|can't get notifications from here|Notifications are blocked/,
  );
});
