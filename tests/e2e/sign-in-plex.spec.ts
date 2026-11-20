import { expect, test } from "@playwright/test";

// Sign in with Plex (11-13, the owner signs in to Tasterr with Plex and has no Tasterr password):
// Tasterr's panel offers Sign in with Plex first and a local login second, before Ember sets
// anything up. (That Ember's custom-panel draft says the same is checked in the Premium package.) The app is
// the stand-in Tasterr (port 8220, DC_FAKE_APPS=1); plex.tv's Allow page is stood in for too.

test("Tasterr offers Sign in with Plex and a local login, and the wording agrees", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  // plex.tv's Allow page, never really opened from a test.
  await page
    .context()
    .route("https://app.plex.tv/**", (r) =>
      r.fulfill({ status: 200, contentType: "text/html", body: "<p>Plex stand-in</p>" }),
    );
  const host = `10.89.${info.project.name === "mobile" ? 2 : 1}.${Date.now() % 250}`;
  const name = `Tasterr ${info.project.name}${Date.now() % 100000}`;
  const added = await page.request.post("/api/services", {
    data: { name, kind: "web", address: `${host}:8220`, category: "Media" },
  });
  expect(added.ok(), await added.text()).toBe(true);
  const { id } = (await added.json()) as { id: string };
  try {
    await page.goto(`/?panels=${encodeURIComponent(`service:${id}`)}`);
    const card = page.getByTestId("sign-in-card");
    await expect(card).toBeVisible({ timeout: 20_000 });
    // Both ways, Plex first; no password asked of a Plex user.
    await expect(card.getByTestId("sign-in-plex").getByRole("button")).toHaveText(
      "Sign in with Plex",
    );
    await expect(card.getByTestId("sign-in-login")).toHaveCount(0);
    await expect(card.getByTestId("sign-in-use-login")).toHaveText(
      `I use a ${name} user name and password instead`,
    );

    // Why: no API key.
    await expect(card.getByTestId("sign-in-why")).toContainText(`${name} has no API key`);
    await page.screenshot({
      path: `test-results/screens/${info.project.name}/sign-in-plex.png`,
    });

    // A local account still has its boxes.
    await card.getByTestId("sign-in-use-login").click();
    await expect(card.getByTestId("sign-in-login")).toBeVisible();
    await expect(card.getByLabel(`${name} password`)).toBeVisible();

    // Sign in with Plex: the Plex window opens, Allow is pressed there, and the draft fills in.
    const [plex] = await Promise.all([
      page.context().waitForEvent("page"),
      card.getByRole("button", { name: "Sign in with Plex" }).click(),
    ]);
    await expect(page.getByTestId("sign-in-saved")).toContainText(
      `Hearth is signed in to ${name}`,
      { timeout: 20_000 },
    );
    await expect(page.getByTestId("sign-in-saved")).toContainText("with Plex");
    await plex.close();
  } finally {
    await page.request.post(`/api/services/${id}/remove`, { data: {} });
  }
});
