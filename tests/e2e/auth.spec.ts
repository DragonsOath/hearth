import { readFileSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// One owner's journey on a fresh installation, in order: claim it, save the
// recovery key, add a passkey, use the vault, then sign out and back in
// every way there is. A virtual authenticator stands in for a fingerprint.
test.describe.configure({ mode: "serial" });

const PASSWORD = "the first e2e password";
const NEW_PASSWORD = "the second e2e password";

async function serious(page: Page) {
  await page.waitForTimeout(400); // let fades finish before measuring contrast
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

async function addFingerprint(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  });
}

let page: Page;
let recoveryKey = "";

test.beforeAll(async ({ browser }, info) => {
  // One context for the whole journey (axe needs a context, not a bare page).
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
    viewport: { width: 1440, height: 900 },
  });
  // Settings starts with its sections open, as for the other tests (settings-fold.spec.ts tests
  // the folding itself).
  await context.addInitScript(() => {
    try {
      if (!localStorage.getItem("settings-fold-default"))
        localStorage.setItem("settings-fold-default", "open");
    } catch {
      /* a page without storage */
    }
  });
  page = await context.newPage();
  await addFingerprint(page);
});
test.afterAll(async () => page.context().close());

const shot = (name: string) =>
  page.screenshot({ path: `test-results/screens/auth/${name}.png`, fullPage: true });

test("a fresh installation asks to be secured, and only with its setup code", async () => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  // First: a new Hearth, or link this PC to one you already have.
  await expect(page.getByRole("heading", { name: "Welcome to Hearth" })).toBeVisible();
  await shot("setup-ask");
  await page.getByTestId("setup-new").click();
  await expect(page.getByRole("heading", { name: "Secure Hearth" })).toBeVisible();
  expect(await serious(page)).toEqual([]);
  await shot("setup");

  // Without the code nothing happens.
  await page.getByLabel("Setup code").fill("WRNG-CODE");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Password again").fill(PASSWORD);
  await page.getByRole("button", { name: "Secure Hearth" }).click();
  await expect(page.getByRole("alert")).toContainText("setup code is not right");

  // The installer opens the page with the code already filled in.
  const code = readFileSync(
    path.join(process.env.DC_E2E_AUTH_DATA_DIR!, "setup-code.txt"),
    "utf8",
  ).trim();
  await page.goto(`/setup?code=${code}`);
  await page.getByTestId("setup-new").click();
  await expect(page.getByLabel("Setup code")).toHaveValue(code);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Password again").fill(PASSWORD);
  await page.getByRole("button", { name: "Secure Hearth" }).click();

  await expect(page.getByRole("heading", { name: "Save your recovery key" })).toBeVisible();
  recoveryKey = (await page.getByTestId("recovery-key").textContent())!.trim();
  expect(recoveryKey).toMatch(/^([A-Z2-9]{4}-){5}[A-Z2-9]{4}$/);
  const next = page.getByRole("button", { name: "Continue" });
  await expect(next).toBeDisabled();
  await page.getByLabel("I have saved my recovery key somewhere safe.").check();
  expect(await serious(page)).toEqual([]);
  await shot("recovery-key");
  await next.click();

  await expect(page.getByRole("heading", { name: "Unlock with your fingerprint" })).toBeVisible();
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByRole("status")).toContainText(
    "It signs you in and unlocks protected secrets.",
  );
  // The account is made: the next stage is where the apps live (onboarding.spec.ts covers it).
  await expect(page.getByTestId("onboarding-stages")).toBeVisible();
  await page.getByRole("button", { name: "Next: Your homelab" }).click();
  await expect(page).toHaveURL(/\/welcome\?step=where$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Where do your apps and files live?",
  );
  // Already signed in: no second account, and no password asked again.
  await expect(page.getByLabel(/password/i)).toHaveCount(0);
  await page.getByRole("button", { name: "Skip setup" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("headline")).toBeVisible();

  // The code is spent: setup cannot be repeated.
  await page.goto(`/setup?code=${code}`);
  await expect(page).toHaveURL(/\/$/);
});

test("the vault keeps automation and protected secrets", async () => {
  await page.goto("/vault");
  await expect(page.getByRole("heading", { name: "Credentials" })).toBeVisible();
  for (const [name, tier, value, category, username] of [
    ["Sonarr API key", "Automation", "sonarr-key-123", "Media", ""],
    ["Router admin", "Protected", "router-pass-456", "Router", "admin"],
  ] as const) {
    await page.getByRole("button", { name: "Add a credential" }).click();
    const sheet = page.getByRole("dialog", { name: "Add a credential" });
    await sheet.getByLabel("Name", { exact: true }).fill(name);
    await sheet.getByLabel("Category").fill(category);
    if (username) await sheet.getByLabel("Username (optional)").fill(username);
    await sheet.getByRole("radio", { name: new RegExp(`^${tier}`) }).click();
    // The box is named after the kind: a password goes in a box that says Password.
    if (username) await sheet.getByLabel("Kind").selectOption({ label: "Password" });
    await sheet.getByLabel(username ? "Password" : "API key", { exact: true }).fill(value);
    if (name === "Router admin") {
      expect(await serious(page)).toEqual([]);
      await shot("vault-add");
    }
    await sheet.getByRole("button", { name: "Add to the vault" }).click();
    await expect(sheet).toBeHidden();
  }
  const rows = page.getByTestId("secret-row");
  await expect(rows).toHaveCount(2);
  // Organised by category; values are never on the page until you ask.
  await expect(page.getByRole("region", { name: "Router · 1" })).toContainText("admin");
  await expect(page.locator("body")).not.toContainText("router-pass-456");

  const router = rows.filter({ hasText: "Router admin" });
  // The value is named after its kind, and the username can be copied on its own.
  await expect(router.locator("dt", { hasText: "Password" })).toBeVisible();
  await expect(
    router.getByRole("button", { name: "Copy the username of Router admin" }),
  ).toBeVisible();
  await router.getByRole("button", { name: "Show" }).click();
  await expect(router.getByTestId("secret-value")).toHaveText("router-pass-456");

  // Locked: a protected secret needs you again, and the fingerprint unlocks it.
  await page.getByRole("button", { name: "Lock now" }).click();
  await expect(page.getByTestId("vault-state")).toContainText(
    "Unlock to show protected credentials",
  );
  await router.getByRole("button", { name: "Hide" }).click();
  await router.getByRole("button", { name: "Show" }).click();
  await expect(router).toContainText("Unlock with your passkey or password to see this one.");
  await router.getByRole("button", { name: "Use a passkey instead" }).click();
  await expect(router.getByTestId("secret-value")).toHaveText("router-pass-456");
  await expect(page.getByTestId("vault-state")).toContainText("Unlocked until");
  await expect(page.getByTestId("sidebar-vault-state")).toContainText("Unlocked until");
  expect(await serious(page)).toEqual([]);
  await shot("vault");
});

test("a service's credential is added from the vault, tried at once, and never shown", async () => {
  await page.goto("/vault");
  const list = page.getByTestId("service-credentials");
  await expect(list).toBeVisible();
  const prowlarr = list.getByRole("listitem").filter({ hasText: "Prowlarr" });
  await expect(prowlarr).toContainText("No credential yet");
  // The app's name goes to the page in Prowlarr where its key is.
  const link = prowlarr.getByTestId("key-page-link");
  await expect(link).toHaveText("Prowlarr");
  const keyPage = await link.getAttribute("href");
  expect(keyPage).toMatch(/^https?:\/\/.+\/settings\/general$/);
  // The app is not really there in the tests: answer its page with a stand-in.
  await page
    .context()
    .route(keyPage!, (r) =>
      r.fulfill({ contentType: "text/html", body: "<title>Prowlarr</title>API Key" }),
    );
  await prowlarr.getByRole("button", { name: "Add" }).click();
  const sheet = page.getByRole("dialog", { name: "Add Prowlarr's API key" });
  await expect(sheet).toContainText("Settings > General > Security > API Key");
  // Wide screen: Prowlarr opens in its own window beside Hearth.
  const opened = page.waitForEvent("popup");
  await sheet.getByRole("button", { name: "Open Prowlarr beside this" }).click();
  const app = await opened;
  expect(app.url()).toBe(keyPage);
  // The app's page is another site: it cannot read anything in Hearth.
  expect(
    await app.evaluate(() => {
      try {
        return (window.opener as Window).document.title;
      } catch {
        return "blocked";
      }
    }),
  ).toBe("blocked");
  await sheet.getByLabel("API key").fill("prowlarr-e2e-key-0042");
  expect(await serious(page)).toEqual([]);
  await sheet.getByRole("button", { name: "Save and try it" }).click();
  // Sample data reads nothing real, so it never claims the credential works.
  await expect(sheet.getByTestId("credential-result")).toContainText("Saved. This is sample data");
  // The key worked (as far as sample data goes): the app's window closes by itself.
  await expect.poll(() => app.isClosed()).toBe(true);
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(prowlarr).toContainText("Stored, not used yet");
  await expect(page.locator("body")).not.toContainText("prowlarr-e2e-key-0042");
  await shot("vault-services");
});

test("signs out, and back in with the passkey or the password", async () => {
  await page.goto("/settings#security");
  const security = page.getByRole("region", { name: "Security" });
  await expect(security.getByTestId("passkey-row")).toContainText("Signs in and unlocks");
  await shot("settings-security");
  await security.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(await serious(page)).toEqual([]);
  await shot("login");

  // Everything is closed while signed out.
  expect((await page.request.get("/api/workspace")).status()).toBe(401);
  await page.goto("/vault");
  await expect(page).toHaveURL(/\/login$/);

  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page).toHaveURL(/\/vault$/);
  // The fingerprint sign-in also unlocked protected secrets.
  await expect(page.getByTestId("vault-state")).toContainText("Unlocked until");

  await page.goto("/settings#security");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Password", { exact: true }).fill("not the password at all");
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page.getByRole("alert")).toContainText("That password is not right.");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page.getByTestId("headline")).toBeVisible();
});

test("the recovery key resets a forgotten password and keeps the secrets", async () => {
  await page.goto("/settings#security");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Forgot your password?" }).click();
  await page.getByLabel("Recovery key").fill(recoveryKey.toLowerCase().replace(/-/g, " "));
  await page.getByLabel("New password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Reset password and sign in" }).click();
  await expect(page.getByTestId("headline")).toBeVisible();

  await page.goto("/vault");
  const router = page.getByTestId("secret-row").filter({ hasText: "Router admin" });
  await router.getByRole("button", { name: "Show" }).click();
  await expect(router.getByTestId("secret-value")).toHaveText("router-pass-456");

  // The old password no longer works; the new one does.
  const old = await page.request.post("/api/auth/login", { data: { password: PASSWORD } });
  expect(old.status()).toBe(401);
});

test("sign-in screens work on a phone", async () => {
  await page.goto("/settings#security");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await shot("login-mobile");
});

test("a sign-in name and new password set with the passkey; the sign-in page asks for both and remembers the device", async () => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByTestId("headline")).toBeVisible();
  await page.goto("/settings#security");
  const set = page.getByTestId("set-credentials");
  await set.getByRole("button", { name: "Set name and password" }).click();
  // The passkey sign-in just now already unlocked the vault, so the form shows straight away.
  await set.getByLabel("Name").fill("Homeserver");
  await set.getByLabel("New password").fill("the third e2e password");
  await set.getByRole("button", { name: "Save name and password" }).click();
  await expect(set).toContainText("Saved.");
  await expect(page.getByTestId("devices")).toContainText("This device");

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator("#username")).toBeVisible();
  await expect(page.getByTestId("remember-device")).toBeChecked();
  await shot("login-with-name");
  await page.locator("#username").fill("homeserver");
  await page.getByLabel("Password", { exact: true }).fill("the third e2e password");
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page.getByTestId("headline")).toBeVisible();
  const cookie = (await page.context().cookies()).find((c) => c.name === "dc_session")!;
  expect(cookie.expires).toBeGreaterThan(Date.now() / 1000 + 80 * 86_400);
});
