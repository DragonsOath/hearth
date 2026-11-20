import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";

// A destination nothing reaches any more (11-13: a Discord webhook deleted in Discord answers 404):
// Notifications says it is broken, names it at the top with a Fix link that opens its Change, and
// the warning clears once a delivery works again.

test("a deleted webhook shows as broken, Fix opens Change, and working again clears it", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const server = http.createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      res.statusCode = req.url === "/gone" ? 404 : 200;
      res.end(req.url === "/gone" ? '{"message":"Unknown Webhook"}' : "{}");
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
    await page.request.put(`/api/notifications/channels/${id}`, {
      data: { values: { url: `${base}/gone` } },
    });
    // The address it sends to was deleted: the next delivery is turned away.
    const sent = await page.request.post(`/api/notifications/channels/${id}/test`);
    expect(((await sent.json()) as { ok: boolean }).ok).toBe(false);

    await page.goto("/notifications");
    const row = page.getByTestId(`channel-${id}`);
    await expect(row).toContainText("Broken");
    await expect(row.getByTestId(`broken-${id}`)).toContainText("no longer exists");
    const notice = page.getByTestId("broken-notice");
    await expect(notice).toContainText(`Lab ${run}`);
    await testInfo.attach("broken", { body: await page.screenshot(), contentType: "image/png" });

    // The notice's Fix link opens this destination's Change.
    await notice.getByRole("link", { name: new RegExp(`Fix (it|Lab ${run})`) }).click();
    const sheet = page.getByRole("dialog", { name: `Change Lab ${run}` });
    await expect(sheet).toBeVisible();
    await sheet.getByLabel("Address", { exact: true }).fill(`${base}/ok`);
    await sheet.getByTestId("change-save").click();
    await expect(sheet).toBeHidden();

    // Working again: the warning goes away.
    await row.getByRole("button", { name: "Send test" }).click();
    await expect(row.getByTestId("test-result")).toContainText("Test sent");
    await page.reload();
    await expect(page.getByTestId(`channel-${id}`)).not.toContainText("Broken");
    await expect(page.getByTestId("broken-notice")).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/notifications/channels/${id}`);
    server.close();
  }
});
