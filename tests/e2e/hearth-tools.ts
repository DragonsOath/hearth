import type { Locator } from "@playwright/test";

/**
 * Opens one of Hearth's tools (Health, Logs, Settings...) on a service panel, the way a person
 * does: from the Hearth menu after the app's tabs, or from the Hearth group in a side menu,
 * unfolding it first.
 */
export async function openHearthTool(panel: Locator, name: string) {
  const hearth = panel.locator('[data-hearth-target="menu:hearth"]').first();
  if ((await hearth.getAttribute("aria-haspopup")) === "menu") {
    await hearth.click();
    await panel.getByRole("menuitemradio", { name, exact: true }).click();
    return;
  }
  if ((await hearth.getAttribute("aria-expanded")) !== "true") await hearth.click();
  await panel.getByRole("tab", { name, exact: true }).click();
}
