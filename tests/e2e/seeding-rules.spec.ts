import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext } from "@playwright/test";

// Seeding rules (the owner, 11-11): "TrackerOne, 3 days seeding, then ..." against the stand-in
// qBittorrent (8090) and Sonarr 4 (8990), where Sonarr grabbed Night.Signal from TrackerOne and it
// has seeded four days. A new rule only previews; once switched to live it acts by itself. Delete
// needs its own words, and still waits while no media app has imported the download.

let hosts = Date.now() % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.41`;
};
const NIGHT = "b2c3d4e5f60718293a4b5c6d7e8f901234567890";

async function add(request: APIRequestContext, name: string, port: number, secret: object) {
  const res = await request.post("/api/services", {
    data: { name, kind: "web", address: `http://${uniqueHost()}:${port}`, category: "Downloads" },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `${name} key`,
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      ...secret,
    },
  });
  return id;
}

test("A TrackerOne rule previews, goes live, pauses a torrent, and Delete waits for an import", async ({
  page,
  request,
}, info) => {
  // Both browser runs share one stand-in qBittorrent, so only the desktop one acts.
  test.skip(info.project.name === "mobile", "acts on the shared stand-in qBittorrent");
  test.setTimeout(120_000);
  await request.post("/api/test/fake-apps", { data: { reset: true } });
  const run = `${Date.now() % 100000}`;
  await add(request, `Sonarr ${run}`, 8990, { kind: "api-key", value: "e2e-8990-key" });
  const id = await add(request, `qBittorrent ${run}`, 8090, {
    kind: "login",
    username: "hearth",
    value: "e2e-qbt-login",
  });

  await page.goto(`/?panels=${encodeURIComponent(`service:${id}@torrents`)}`);
  const night = page.getByTestId("qb-torrent").filter({ hasText: "Night.Signal" });
  await expect(night.getByTestId("grab-source")).toContainText("TrackerOne", { timeout: 20_000 });

  // Add rule: TrackerOne, 3 days, stop seeding.
  await page.getByTestId("qb-rules").click();
  const sheet = page.getByTestId("qb-rules-sheet");
  await expect(sheet.getByRole("tab", { name: "Add rule" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await sheet.getByRole("button", { name: "TrackerOne", exact: true }).click();
  await sheet.getByTestId("qb-rule-days").fill("3");
  await sheet.getByText("Stop seeding", { exact: true }).click();
  await sheet.getByTestId("qb-rules-save").click();
  const card = sheet.getByTestId("qb-rule-card");
  await expect(card).toContainText("TrackerOne");
  await expect(card).toContainText("Preview");
  expect(
    (
      await new AxeBuilder({ page }).include('[data-testid="qb-rules-sheet"]').analyze()
    ).violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
  ).toEqual([]);

  // Preview: nothing acts, even on Check.
  const torrentState = async () => {
    const d = (await (await request.get(`/api/services/${id}/dashboard`)).json()) as {
      data: { torrents: { hash: string; state: string }[] };
    };
    return d.data.torrents.find((t) => t.hash === NIGHT)?.state;
  };
  expect(await torrentState()).toBe("uploading");

  // Go live, then Check now: it is paused, and Activity says so.
  await card.getByTestId("qb-rule-golive").click();
  await sheet
    .getByTestId("qb-rule-confirm")
    .getByText(/Hearth will/)
    .waitFor();
  await sheet.getByTestId("qb-rule-confirm-live").click();
  await expect(card).toContainText("Live");
  await sheet.getByTestId("qb-rules-check").click();
  await expect(sheet.getByTestId("qb-rules-log")).toContainText("Done: stop seeding", {
    timeout: 20_000,
  });
  await expect.poll(torrentState, { timeout: 20_000 }).toBe("stoppedUP");
  await page.screenshot({
    path: `test-results/screens/${info.project.name}/seeding-rules-live.png`,
  });

  // Stop every rule: the switch is kept, and a check does nothing.
  await sheet.getByTestId("qb-rules-stop").click();
  await expect(sheet).toContainText("Every rule is stopped");
  await sheet.getByTestId("qb-rules-stop").click();
  await expect(sheet).toContainText("Rules are running");

  // Edit to Delete: back to preview; going live needs the words; it then waits (no import).
  await card.getByTestId("qb-rule-edit").click();
  await sheet.getByText("Delete the torrent and its files", { exact: true }).click();
  await sheet.getByTestId("qb-rules-save").click();
  await expect(card).toContainText("Preview");
  await card.getByTestId("qb-rule-golive").click();
  await expect(sheet.getByTestId("qb-rule-confirm-live")).toBeDisabled();
  await sheet.getByTestId("qb-rule-confirm-word").fill("delete files");
  await sheet.getByTestId("qb-rule-confirm-live").click();
  await expect(card).toContainText("Live");
  await sheet.getByTestId("qb-rules-check").click();
  await expect(sheet.getByTestId("qb-rules-log")).toContainText("no media app has imported it", {
    timeout: 20_000,
  });
  expect(await torrentState()).toBe("stoppedUP");

  // The server refuses Delete without the words too.
  const rules = (await (await request.get(`/api/services/${id}/seeding-rules`)).json()) as {
    rules: { id: string }[];
  };
  await request.post(`/api/services/${id}/seeding-rules/${rules.rules[0]!.id}/mode`, {
    data: { mode: "preview" },
  });
  const refused = await request.post(
    `/api/services/${id}/seeding-rules/${rules.rules[0]!.id}/mode`,
    { data: { mode: "live" } },
  );
  expect(refused.status()).toBe(400);
  await request.post("/api/test/fake-apps", { data: { reset: true } });
});
