import { describe, expect, it } from "vitest";
import { actualDashboard, readActual } from "./actual";
import { fakeActual } from "./fake-actual";

/**
 * Actual Budget against the stand-in (answering as a throwaway 26.11.0 did; actual-real.test.ts runs
 * the same reads against a real one): health, version and budget names, a session reused across
 * reads, and never the password or a budget's encryption details.
 */

const at = (n: number) => `http://10.0.0.${n}:5006`;
const PASSWORD = "e2e-actual-password";

describe("reading Actual Budget", () => {
  it("reads health, version, memory, uptime and budget names, and reuses its session", async () => {
    const fake = fakeActual();
    const d = await actualDashboard(fake.fetch, at(11), PASSWORD);
    expect(d).toMatchObject({
      version: "26.11.0",
      healthy: true,
      memoryMb: 180,
      uptime: 259_320,
      loginMethods: ["Password"],
      deleted: 1,
    });
    expect(d.budgets).toEqual([
      { id: "f-household", name: "Household 2026", encrypted: true, people: 2 },
      { id: "f-trip", name: "Summer trip", encrypted: false, people: 1 },
    ]);
    await actualDashboard(fake.fetch, at(11), PASSWORD);
    expect(fake.signIns()).toBe(1);
    const text = JSON.stringify(d);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("key-1");
    expect(text).not.toContain("session-");
  });

  it("signs in again when the server forgets the session", async () => {
    const fake = fakeActual();
    await actualDashboard(fake.fetch, at(12), PASSWORD);
    fake.reset();
    expect((await actualDashboard(fake.fetch, at(12), PASSWORD)).budgets).toHaveLength(2);
    expect(fake.signIns()).toBe(1);
  });

  it("refuses a wrong password plainly and reports health", async () => {
    const fake = fakeActual();
    await expect(actualDashboard(fake.fetch, at(13), "wrong")).rejects.toThrow(
      /refused the server password/,
    );
    expect(await readActual(at(13), PASSWORD, fake.fetch)).toMatchObject({
      status: "ok",
      facts: [{ label: "Budgets", value: "2" }],
    });
  });
});
