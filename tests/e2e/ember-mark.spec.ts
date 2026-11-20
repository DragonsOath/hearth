import { expect, test } from "@playwright/test";

// The Ember mark (11-12, the owner: "I don't want them thinking I'm just clicking a button, no
// harm"): a button that starts Ember carries Ember's mark, and its first press in a browser says
// it starts Ember and uses the AI plan before anything is sent. Cancel sends nothing.

test("a button that starts Ember carries the mark and explains itself on the first press", async ({
  page,
  request,
}, info) => {
  const name = `Widget ${info.project.name}${Date.now() % 100000}`;
  const res = await request.post("/api/services", {
    data: {
      name,
      kind: "web",
      address: `http://10.77.${info.project.name === "mobile" ? 2 : 1}.${Date.now() % 250}:7777`,
      category: "Automation",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;

  // A browser that has not seen the note yet.
  await page.addInitScript(() => localStorage.removeItem("dc-ember-mark-seen"));
  await page.goto(`/?panels=${encodeURIComponent(`service:${id}@overview`)}`);
  // A basic panel shows the app itself first (11-14); Hearth's own panel is Hearth view.
  await page.getByTestId("app-view-hearth").click({ timeout: 20_000 });
  const ask = page.getByTestId("generic-ask");
  await expect(ask).toBeVisible({ timeout: 20_000 });
  await expect(ask.getByTestId("ember-mark")).toBeVisible();

  // Cancel: the note closes and nothing is sent.
  await ask.click();
  const notice = page.getByTestId("ember-mark-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("This button starts");
  await expect(notice).toContainText(
    "Buttons without it talk to your apps directly and use no AI.",
  );
  await page.screenshot({
    path: `test-results/screens/${info.project.name}/ember-mark-notice.png`,
  });
  await notice.getByRole("button", { name: "Cancel" }).click();
  await expect(notice).toHaveCount(0);

  // Start: with "don't show this again", the note goes and Ember gets the question.
  await ask.click();
  await notice.getByLabel("Got it, don't show this again").check();
  await notice.getByTestId("ember-mark-run").click();
  await expect(notice).toHaveCount(0);
  if (info.project.name === "mobile")
    await page.getByRole("button", { name: "Show Ember" }).click();
  await expect(page.getByText(/What can you see and do in it\?/).first()).toBeVisible({
    timeout: 20_000,
  });
  expect(await page.evaluate(() => localStorage.getItem("dc-ember-mark-seen"))).toBe("1");
});
