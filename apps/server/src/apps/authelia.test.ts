import { describe, expect, it } from "vitest";
import { autheliaDashboard, metric, metricsUrl, readAuthelia } from "./authelia";
import { fakeAuthelia } from "./fake-authelia";

/**
 * Authelia against the stand-in (answering as a throwaway 4.39.28 did; authelia-real.test.ts reads a
 * real one): health and sign-in counts from its metrics, and a plain note when metrics are off.
 */

const BASE = "http://10.0.0.9:9092";

describe("reading Authelia", () => {
  it("reads health and sign-ins, failed, banned, timing, errors, uptime and memory", async () => {
    const fake = fakeAuthelia();
    const d = await autheliaDashboard(fake.fetch, BASE);
    expect(d).toMatchObject({
      healthy: true,
      metrics: true,
      signIns: 142,
      failed: 4,
      banned: 2,
      signInMs: 215,
      serverErrors: 1,
      memoryMb: 40,
    });
    expect(Date.now() - Date.parse(d.since!)).toBeGreaterThan(86_400_000);
    const r = await readAuthelia(BASE, fake.fetch);
    expect(r.issues.map((i) => i.key)).toEqual(["banned", "server-errors"]);
  });

  it("says plainly when metrics are off", async () => {
    const fake = fakeAuthelia();
    fake.metricsOff(true);
    expect(await autheliaDashboard(fake.fetch, BASE)).toEqual({
      app: "authelia",
      healthy: true,
      metrics: false,
      metricsAddress: "http://10.0.0.9:9959/metrics",
    });
    expect((await readAuthelia(BASE, fake.fetch)).facts).toEqual([
      { label: "Metrics", value: "off" },
    ]);
  });

  it("reads Prometheus samples by labels", () => {
    const text = 'a{x="1",y="2"} 3\na{x="1",y="3"} 4\nab 9\n';
    expect(metric(text, "a", { x: "1" })).toBe(7);
    expect(metric(text, "a", { y: "3" })).toBe(4);
    expect(metric(text, "b")).toBeUndefined();
    expect(metricsUrl("https://auth.example.com/")).toBe("https://auth.example.com:9959/metrics");
  });
});
