import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test as setup } from "@playwright/test";

export const OWNER_PASSWORD = "e2e owner password";

// Claims the main test server once, the way an installer would: with the
// one-time code it wrote next to its database. Every other test then runs
// as the signed-in owner.
setup("claim the installation", async ({ request, baseURL }) => {
  const dataDir = process.env.DC_E2E_DATA_DIR!;
  const code = readFileSync(path.join(dataDir, "setup-code.txt"), "utf8").trim();
  const res = await request.post("/api/auth/setup", { data: { code, password: OWNER_PASSWORD } });
  expect(res.status(), await res.text()).toBe(200);
  // The other suites start from an owner who is past the first-run welcome; it has its own
  // fresh installations and tests (onboarding.spec.ts).
  const done = await request.patch("/api/settings", { data: { onboardingDone: true } });
  expect(done.status(), await done.text()).toBe(204);
  // Hearth Premium for the main test Hearth, so the suites that link PCs or use Show & Tell run
  // as they always have: a test signing key (trusted only under DC_FAKE_APPS) and a grant for
  // this installation. premium.spec.ts tests the free side, revoking and reinstating it.
  const key = await request.post("/api/premium/issuer/setup", { data: {} });
  expect(key.status(), await key.text()).toBe(200);
  const { installId } = (await (await request.get("/api/premium")).json()) as { installId: string };
  const grant = await request.post("/api/premium/issuer/grants", {
    data: { recipient: "The test owner", audience: "self", scope: ["premium_all"], installId },
  });
  expect(grant.status(), await grant.text()).toBe(200);
  const state = await request.storageState();
  // The owner has seen the Ember mark's first-press note, so buttons that start Ember start it
  // straight away, as they always have (ember-mark.spec.ts tests the note on its own).
  state.origins = [
    {
      origin: new URL(baseURL!).origin,
      localStorage: [
        { name: "dc-ember-mark-seen", value: "1" },
        // Settings starts with its sections open (Open all), so tests reach what is inside;
        // settings-fold.spec.ts tests the folding itself.
        { name: "settings-fold-default", value: "open" },
      ],
    },
  ];
  mkdirSync("test-results/.auth", { recursive: true });
  writeFileSync("test-results/.auth/owner.json", JSON.stringify(state));
});
