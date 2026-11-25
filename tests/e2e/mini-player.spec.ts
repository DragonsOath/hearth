import { expect, test } from "@playwright/test";

// The mini player (11-24): while music plays and the Home Assistant dashboard isn't on screen, a
// card with the cover, play/pause, next and back follows you around Hearth. It starts top right,
// can be dragged (remembered), steps aside on the dashboard, and its X stops the music.

test("Mini player: controls, drag, hides on the dashboard, X stops the music", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const run = `${info.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.18`;
  await page.request.post("/api/test/fake-apps", { data: { reset: true } });
  const res = await page.request.post("/api/services", {
    data: {
      name: `Home Assistant ${run}`,
      kind: "web",
      address: `http://${host}:8123`,
      category: "Home",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  try {
    await page.request.post("/api/vault/secrets", {
      data: {
        name: `Home Assistant ${run} token`,
        kind: "api-key",
        tier: "automation",
        scope: "approved-changes",
        serviceId: id,
        value: "e2e-home-token",
      },
    });
    await page.goto("/");
    await page.evaluate(() => localStorage.removeItem("hearth.miniPlayer.place"));
    await page.reload();
    const mini = page.getByTestId("mini-player");
    await expect(mini).toBeVisible({ timeout: 20_000 });
    await expect(mini.getByTestId("mini-player-title")).toHaveText("Harbor Song");
    // Top right to start with.
    const vw = page.viewportSize()!.width;
    const box = (await mini.boundingBox())!;
    expect(box.x + box.width).toBeGreaterThan(vw - 40);
    expect(box.y).toBeLessThan(120);
    await page.screenshot({ path: `test-results/screens/${info.project.name}/mini-player.png` });

    // Pause, play, next.
    await mini.getByRole("button", { name: "Pause" }).click();
    await expect(mini.getByRole("button", { name: "Play" })).toBeVisible();
    await mini.getByRole("button", { name: "Play" }).click();
    await mini.getByRole("button", { name: "Next" }).click();
    await expect(mini.getByTestId("mini-player-title")).toHaveText("Second Song", {
      timeout: 15_000,
    });

    // Dragged down and left; still there after a reload.
    const title = mini.getByTestId("mini-player-title");
    const t = (await title.boundingBox())!;
    await page.mouse.move(t.x + 10, t.y + 5);
    await page.mouse.down();
    await page.mouse.move(60, 400, { steps: 8 });
    await page.mouse.up();
    const moved = (await mini.boundingBox())!;
    expect(moved.x).toBeLessThan(120);
    await page.reload();
    await expect(mini).toBeVisible({ timeout: 20_000 });
    expect(Math.abs((await mini.boundingBox())!.x - moved.x)).toBeLessThan(4);

    // The Home Assistant dashboard has its own player: the card steps aside there.
    await page.goto(`/?panels=${encodeURIComponent(`service:${id}@home`)}`);
    await expect(page.getByTestId("home-dashboard")).toBeVisible({ timeout: 20_000 });
    await expect(mini).toHaveCount(0);

    // Back elsewhere, X stops the music and the card goes.
    await page.goto("/");
    await expect(mini).toBeVisible({ timeout: 20_000 });
    await mini.getByTestId("mini-player-close").click();
    await expect(mini).toHaveCount(0);
    await expect
      .poll(async () => {
        const d = (await (await page.request.get("/api/home")).json()) as {
          music: { entity: string; state: string }[];
        };
        return d.music.find((m) => m.entity === "media_player.kitchen_speaker")?.state;
      })
      .toBe("idle");
  } finally {
    await page.request.post(`/api/services/${id}/remove`, { data: {} });
    await page.request.post("/api/test/fake-apps", { data: { reset: true } });
  }
});
