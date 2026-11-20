import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
const OWNER_PASSWORD = "e2e owner password";

// The Lab Blueprint (11-11): set up in Settings with a folder and a recovery key that has to be
// typed back, a first version written at once, the key tested, and an import that shows what a
// blueprint holds before anything is added. The machine is the stand-in one (DC_FAKE_APPS=1).

test("The Lab Blueprint is set up with its key typed back, tests the key, and an import shows what it holds first", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const folder = mkdtempSync(path.join(tmpdir(), "hearth-blueprint-e2e-"));
  try {
    // Every step needs a fresh "it's you": sign in again, as the owner would.
    const login = await page.request.post("/api/auth/login", {
      data: { password: OWNER_PASSWORD },
    });
    expect(login.status(), await login.text()).toBeLessThan(300);
    await page.goto("/settings#blueprint");
    const setup = page.getByTestId("blueprint-setup");
    await expect(setup).toBeVisible({ timeout: 20_000 });

    // A folder that doesn't exist is refused plainly.
    await page.getByLabel(/Folder to save blueprints in/).fill(path.join(folder, "missing"));
    await page.getByRole("button", { name: "Next: the key" }).click();
    await expect(page.getByText(/doesn't exist/)).toBeVisible();

    await page.getByLabel(/Folder to save blueprints in/).fill(folder);
    await page.getByRole("button", { name: "Next: the key" }).click();
    const keyText = page.getByTestId("blueprint-recovery-key");
    await expect(keyText).toHaveText(/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/);
    const key = (await keyText.textContent())!.trim();

    // Finishing waits for the "I saved it" box and the key typed back; a wrong key is refused.
    const finish = page.getByRole("button", { name: "Finish and write the first one" });
    await expect(finish).toBeDisabled();
    await page.getByLabel(/I saved the key/).check();
    await page.getByLabel(/Type or paste the key back/).fill(key.slice(0, -1) + "Q");
    await finish.click();
    await expect(
      page.getByText(/recovery key is damaged|isn.t the recovery key just shown/),
    ).toBeVisible();
    await page.getByLabel(/Type or paste the key back/).fill(key);
    await finish.click();

    const status = page.getByTestId("blueprint-status");
    await expect(status).toContainText("Up to date", { timeout: 30_000 });
    await expect(page.getByText(folder, { exact: true })).toBeVisible();
    const files = readdirSync(folder).filter((f) => /^hearth-blueprint-\d{8}-\d{6}\.age$/.test(f));
    expect(files).toHaveLength(1);

    // Nothing changed: Update now says so and writes nothing new.
    await page.getByRole("button", { name: "Update now" }).click();
    await expect(status).toContainText("Nothing changed");
    expect(readdirSync(folder).filter((f) => f.endsWith(".age"))).toHaveLength(1);

    // What it says: the stand-in apps, with compose values hidden.
    await page.getByRole("button", { name: "See what it says" }).click();
    const text = page.getByTestId("blueprint-preview");
    await expect(text).toContainText("sonarr");
    await expect(text).not.toContainText("e2e-not-a-real-key");

    // The key opens the newest version.
    await page.getByRole("button", { name: "Test my key" }).click();
    await page.getByLabel("Recovery key", { exact: true }).fill(key);
    await page.getByRole("button", { name: "Test the key" }).click();
    await expect(page.getByText(/^It opens\./)).toBeVisible();

    // Import shows what the blueprint holds before adding anything.
    await page.getByRole("button", { name: "Import a blueprint" }).click();
    await page.getByLabel("Blueprint file").setInputFiles(path.join(folder, files[0]!));
    await page.getByLabel("Recovery key for the import").fill(key);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    const preview = page.getByTestId("blueprint-import-preview");
    await expect(preview).toContainText(/\d+ apps/);
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await expect(page.getByTestId("blueprint-imported")).toContainText("Imported.");

    // Ember may read it, never set it up or update it.
    const ember = await page.request.get("/api/blueprint/imported");
    expect(ember.status()).toBe(200);

    // Turning off forgets the folder and key; the version stays in the folder.
    await page.getByRole("button", { name: "Turn off", exact: true }).click();
    await page.getByRole("button", { name: "Turn off the Lab Blueprint" }).click();
    await expect(page.getByTestId("blueprint-setup")).toBeVisible();
    expect(readdirSync(folder).filter((f) => f.endsWith(".age"))).toHaveLength(1);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// Cloud storage (11-11): offered beside a folder. The stand-in cloud answers as S3 with the
// e2e-access-key / e2e-secret-key login and the bucket hearth-test (DC_FAKE_APPS=1 only).
test("The Lab Blueprint can be saved to cloud storage, with its login kept in the vault", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const login = await page.request.post("/api/auth/login", {
    data: { password: OWNER_PASSWORD },
  });
  expect(login.status(), await login.text()).toBeLessThan(300);
  await page.goto("/settings#blueprint");
  await expect(page.getByTestId("blueprint-setup")).toBeVisible({ timeout: 20_000 });

  await page.getByRole("radio", { name: "Cloud storage" }).click();
  await page.getByLabel("Cloud service").selectOption("b2");
  await page.getByLabel("Endpoint", { exact: true }).fill("https://s3.us-west-004.backblazeb2.com");
  await page.getByLabel("Bucket", { exact: true }).fill("hearth-test");
  await page.getByLabel("Application key ID", { exact: true }).fill("e2e-access-key");
  await page.getByLabel("Application key", { exact: true }).fill("wrong-secret");
  await page.getByRole("button", { name: "Next: the key" }).click();
  await expect(page.getByText(/turned the login down/)).toBeVisible();

  await page.getByLabel("Application key", { exact: true }).fill("e2e-secret-key");
  await page.getByRole("button", { name: "Next: the key" }).click();
  await expect(page.getByTestId("blueprint-cloud-ok")).toContainText(
    "Backblaze B2: hearth-test/hearth-blueprint",
  );
  const key = (await page.getByTestId("blueprint-recovery-key").textContent())!.trim();
  await page.getByLabel(/I saved the key/).check();
  await page.getByLabel(/Type or paste the key back/).fill(key);
  await page.getByRole("button", { name: "Finish and write the first one" }).click();

  await expect(page.getByTestId("blueprint-status")).toContainText("Up to date", {
    timeout: 30_000,
  });
  await expect(page.getByText("Backblaze B2: hearth-test/hearth-blueprint")).toBeVisible();
  const status = await (await page.request.get("/api/blueprint")).text();
  expect(status).not.toContain("e2e-secret-key");

  await page.getByRole("button", { name: "Test my key" }).click();
  await page.getByLabel("Recovery key", { exact: true }).fill(key);
  await page.getByRole("button", { name: "Test the key" }).click();
  await expect(page.getByText(/^It opens\./)).toBeVisible();

  await page.getByRole("button", { name: "Turn off", exact: true }).click();
  await expect(page.getByText(/removes the cloud login from the vault/)).toBeVisible();
  await page.getByRole("button", { name: "Turn off the Lab Blueprint" }).click();
  await expect(page.getByTestId("blueprint-setup")).toBeVisible();
});
