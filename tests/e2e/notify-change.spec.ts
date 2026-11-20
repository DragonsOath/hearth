import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";

// Notifications, Change (11-13): every part of a destination edited in place, one save. Send with
// switches the way it sends and asks only what the new way needs; Send test tries the new settings
// before saving; Switch back returns to the old way (its address kept); Undo puts a save back.

test("Change a destination: switch how it sends, test first, save once, switch back and undo", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      hits.push(req.url ?? "");
      res.statusCode = 200;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const made = await page.request.post("/api/notifications/destinations", {
    data: { kind: "webhook", name: `Lab ${run}`, audience: "private" },
  });
  expect(made.status(), await made.text()).toBe(200);
  const id = ((await made.json()) as { id: string }).id;
  try {
    const setUp = await page.request.put(`/api/notifications/channels/${id}`, {
      data: { values: { url: `${base}/hook` } },
    });
    expect(setUp.status(), await setUp.text()).toBe(204);

    await page.goto("/notifications");
    const row = page.getByTestId(`channel-${id}`);
    await row.getByTestId(`change-${id}`).click();
    const sheet = page.getByRole("dialog", { name: `Change Lab ${run}` });
    await expect(sheet).toBeVisible();

    // Every field is there to edit: name, Send with, who reads it, quiet hours, messages.
    await sheet.getByLabel("Name", { exact: true }).fill(`Alerts ${run}`);
    await sheet.getByLabel("Send with").selectOption("ntfy");
    await expect(sheet.getByTestId("change-switch-note")).toContainText("settings are kept");
    // Only what ntfy needs is asked.
    await expect(sheet.getByLabel("Topic", { exact: true })).toBeVisible();
    await expect(sheet.getByLabel("Address", { exact: true })).toHaveCount(0);
    await sheet.getByLabel("Server", { exact: true }).fill(base);
    await sheet.getByLabel("Topic", { exact: true }).fill(`lab-${run}`);
    await sheet.getByText("Send any time").click();
    const messages = sheet.getByTestId("change-messages");
    await messages.getByRole("checkbox").first().check();

    // Send test before saving: it goes the new way, and nothing is saved yet.
    await sheet.getByTestId("change-try").click();
    await expect(sheet.getByTestId("change-try-ok")).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => hits).toContain(`/lab-${run}`);
    await testInfo.attach("change", { body: await page.screenshot(), contentType: "image/png" });

    // One save.
    await sheet.getByTestId("change-save").click();
    await expect(sheet).toBeHidden();
    await expect(row).toContainText(`Alerts ${run}`);
    await expect(row).toContainText("ntfy");

    // Switch back: the webhook (its address kept) works again; the new name stays.
    await row.getByTestId(`change-${id}`).click();
    const again = page.getByRole("dialog", { name: `Change Alerts ${run}` });
    await expect(again.getByTestId("change-previous")).toContainText("Webhook");
    await again.getByTestId("change-switch-back").click();
    await expect(again).toBeHidden();
    await expect(row).toContainText("webhook");
    await expect(row).toContainText(`Alerts ${run}`);
    hits.length = 0;
    await row.getByRole("button", { name: "Send test" }).click();
    await expect.poll(() => hits).toContain("/hook");

    // Undo the switch back: ntfy again.
    await row.getByTestId(`undo-${id}`).click();
    await expect(row).toContainText("ntfy");

    // In Changes and activity.
    const audit = (await (await page.request.get("/api/audit?limit=10")).json()) as {
      action: string;
    }[];
    expect(audit.map((a) => a.action)).toContain(
      `Changed Lab ${run} notifications: renamed to Alerts ${run}, now sent with ntfy`,
    );
  } finally {
    await page.request.delete(`/api/notifications/channels/${id}`);
    server.close();
  }
});
