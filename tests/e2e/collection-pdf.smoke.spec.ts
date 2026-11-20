import { expect, test } from "@playwright/test";

// Collection PDF (Storage & Files): pick folders, Make PDF, then open, download, or share it.

test("Collection PDF: pick folders, make the PDF, open and download it", async ({ page }) => {
  const scenario = await page.request.post("/api/demo/scenario", {
    data: { scenario: "attention", replaceYourSystems: true },
  });
  expect(scenario.ok(), await scenario.text()).toBeTruthy();
  // Start from no folders (the desktop and mobile runs share one Hearth).
  const reset = await page.request.put("/api/catalog/settings", {
    data: { title: "The Full Collection", shelves: [] },
  });
  expect(reset.ok(), await reset.text()).toBeTruthy();

  await page.goto("/?panels=tool%3Astorage&focus=tool%3Astorage");
  const panel = page.getByTestId("storage-center");
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await panel.getByRole("tab", { name: "Collection PDF" }).click();
  const cat = panel.getByTestId("collection-catalog");
  await expect(cat).toContainText("No folders yet");

  for (const [root, kind] of [
    ["Movies", "movies"],
    ["Shows", "shows"],
  ] as const) {
    await cat.getByTestId("catalog-add-folder").click();
    const picker = cat.getByTestId("catalog-picker");
    await picker.getByLabel("Drive or folder").selectOption({ label: root });
    await expect(picker.getByTestId("catalog-picker-folder").first()).toBeVisible();
    await picker.getByTestId("catalog-use-folder").click();
    const shelf = cat.getByTestId("catalog-shelf").last();
    await expect(shelf.getByLabel("Name in the PDF")).toHaveValue(root);
    await expect(shelf.getByRole("combobox", { name: `What ${root} holds` })).toHaveValue(kind);
  }

  await cat.getByLabel("PDF title").fill("Our Movie Night List");
  await cat.getByTestId("catalog-make").click();
  const made = cat.getByTestId("catalog-file").first();
  await expect(made).toBeVisible({ timeout: 30_000 });
  await expect(made).toContainText("Our Movie Night List");
  await expect(made).toContainText(/Movies \d+ · Shows \d+/);
  await made.screenshot({ path: "test-results/collection-pdf.png" });

  // Open shows the PDF itself; Download saves it with a readable name.
  const href = await made.getByTestId("catalog-open").getAttribute("href");
  const pdf = await page.request.get(href!);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect(pdf.headers()["content-disposition"]).toMatch(/^inline;/);
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
  await expect(made.getByTestId("catalog-download")).toHaveAttribute(
    "download",
    /^Our Movie Night List \d{4}-\d{2}-\d{2}\.pdf$/,
  );
  const dl = await page.request.get(`${href}?download=1`);
  expect(dl.headers()["content-disposition"]).toMatch(/^attachment;/);
  await expect(made.getByTestId("catalog-share")).toBeVisible();

  // The folders were saved with the PDF.
  const state = await (await page.request.get("/api/catalog")).json();
  expect(state.settings.shelves.map((s: { name: string }) => s.name)).toEqual(["Movies", "Shows"]);
});
