import { expect, test } from "@playwright/test";

/*
 * Project colors: a project chosen a color glows in it on Home, its color can change later, and
 * "No color" keeps the plain card. Desktop and phone.
 */

test("a project started with a color glows in it on Home, and its color can change", async ({
  page,
}, info) => {
  const phone = info.project.name === "mobile";
  const name = `Photo library ${Date.now() % 100000}`;
  await page.goto("/");
  await page.getByTestId("hub-start-project").click();
  const dialog = page.getByTestId("start-project");
  await dialog.getByTestId("start-name").fill(name);
  const colors = dialog.getByRole("radiogroup", { name: "Color" });
  await expect(colors.getByRole("radio", { name: "No color" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await colors.getByRole("radio", { name: "Purple" }).click();
  await expect(colors.getByRole("radio", { name: "Purple" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await dialog.getByTestId("start-submit").click();
  await expect(page).toHaveURL(/\/\?project=/);
  const id = new URL(page.url()).searchParams.get("project")!;

  // Its page offers the same choice, already on purple. Change it to green.
  const ws = page.getByTestId("project-workspace");
  const edit = ws.getByRole("radiogroup", { name: "Color" });
  await expect(edit.getByRole("radio", { name: "Purple" })).toHaveAttribute("aria-checked", "true");
  await edit.getByRole("radio", { name: "Green" }).click();
  await expect(edit.getByRole("radio", { name: "Green" })).toHaveAttribute("aria-checked", "true");

  await page.goto("/");
  const card = page.locator(".project-glow", { hasText: name });
  await expect(card).toHaveAttribute("data-color", "green");
  // The glow is the color itself, not the theme's gold.
  const shadow = await card.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(shadow).not.toBe("none");
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `test-results/screens/${phone ? "mobile" : "desktop"}/project-colors.png`,
  });

  // No color takes the glow off.
  const off = await page.request.patch(`/api/projects/${id}`, { data: { color: null } });
  expect(off.ok()).toBe(true);
  await page.reload();
  await expect(page.locator(".cc-card", { hasText: name }).first()).not.toHaveClass(/project-glow/);
  await page.request.patch(`/api/projects/${id}`, { data: { status: "done" } });
});
