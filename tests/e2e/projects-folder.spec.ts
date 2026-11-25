import { expect, test } from "@playwright/test";

// The Projects folder (11-24): on each PC's card in Settings, PCs and devices, where War Room
// projects made on that PC are saved; changed, with the projects moved too if you like.

test("Projects folder: said plainly, changed, and put back", async ({ page }, info) => {
  const was = (
    (await (await page.request.get("/api/engine/projects-folder")).json()) as { folder: string }
  ).folder;
  const sep = was.includes("\\") ? "\\" : "/";
  const next = `${was}-${info.project.name}${Date.now() % 100000}`;
  try {
    await page.goto("/settings#devices");
    await page.getByTestId("pc-projects-folder").first().click();
    const box = page.getByTestId("projects-folder");
    await expect(box).toContainText("Where War Room projects made on this PC are saved");
    const input = box.getByTestId("projects-folder-path");
    await expect(input).toHaveValue(was);
    // A relative path is refused, said plainly.
    await input.fill(`projects${sep}here`);
    await box.getByTestId("projects-folder-save").click();
    await expect(box).toContainText("whole path");
    await input.fill(next);
    await box.screenshot({ path: `test-results/screens/${info.project.name}/projects-folder.png` });
    await box.getByTestId("projects-folder-save").click();
    await expect(box.getByTestId("projects-folder-done")).toContainText(
      `New projects go to ${next}`,
    );
  } finally {
    await page.request.put("/api/engine/projects-folder", { data: { folder: was } });
  }
});
