import { expect, test } from "@playwright/test";

// Saved sign-ins (11-12, the owner: "your sync doesn't work"): an app that signs in with its own
// login asks for that login right on its panel, instead of saying "add it from the panel" with
// nowhere to put it. The app is the stand-in Tasterr (port 8220, DC_FAKE_APPS=1).

test("an app that needs its login asks for it on the panel, then signs in", async ({
  page,
}, info) => {
  // A made-up address per run (the stand-in answers on its port), so desktop and phone each add one.
  const host = `10.88.${info.project.name === "mobile" ? 2 : 1}.${Date.now() % 250}`;
  // Its own name too: a name already signed in by another run would skip the login boxes.
  const name = `Taste Test ${info.project.name}${Date.now() % 100000}`;
  const added = await page.request.post("/api/services", {
    data: { name, kind: "web", address: `${host}:8220`, category: "Media" },
  });
  expect(added.ok(), await added.text()).toBe(true);
  const { id } = (await added.json()) as { id: string };
  const recipe = await page.request.put(`/api/services/${id}/sign-in`, {
    data: {
      type: "login",
      path: "/api/v1/auth/local",
      format: "json",
      userField: "email",
      passField: "password",
    },
  });
  expect(recipe.ok(), await recipe.text()).toBe(true);

  await page.goto(`/?panels=${encodeURIComponent(`service:${id}`)}`);
  const form = page.getByTestId("sign-in-login");
  await expect(form).toBeVisible({ timeout: 20_000 });
  const save = form.getByRole("button", { name: "Save and sign in" });
  await expect(save).toBeDisabled();

  // A wrong password is said plainly, and the boxes stay for another try.
  await form.getByLabel(`${name} user name or email`).fill("owner@example.com");
  await form.getByLabel(`${name} password`).fill("not-the-password");
  await save.click();
  await expect(page.getByTestId("sign-in-card").getByRole("alert")).toContainText(/refused/);

  // The right one replaces it: the boxes stayed, the user name is kept.
  await expect(form.getByLabel(`${name} user name or email`)).toHaveValue("owner@example.com");
  await form.getByLabel(`${name} password`).fill("e2e-tasterr-login");
  await form.getByRole("button", { name: "Save and sign in" }).click();
  await expect(page.getByTestId("sign-in-saved")).toContainText(`Hearth is signed in to ${name}`);
  await page.screenshot({
    path: `test-results/screens/${test.info().project.name}/sign-in-card.png`,
  });
  // The password went to the vault, never back to the page.
  expect(await page.content()).not.toContain("e2e-tasterr-login");
});
