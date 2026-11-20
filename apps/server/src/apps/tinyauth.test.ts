import { describe, expect, it } from "vitest";
import { parseTinyauthLog } from "./tinyauth";

/** Lines as Tinyauth 5 writes them (coloured), some with Docker's timestamp in front. */
const C = (s: string) => `\u001b[36m${s}\u001b[0m`;
const ask = (time: string, ip: string, status: number) =>
  `\u001b[90m${time}\u001b[0m \u001b[32mINF\u001b[0m Request ${C("address=")}172.17.0.1:4000 ${C("client_ip=")}${ip} ${C("latency=")}"39.5µs" ${C("method=")}GET ${C("path=")}/api/auth/caddy ${C("status=")}${status} stream=http`;

describe("parseTinyauthLog", () => {
  it("counts who was let in, sent to sign in, or refused, and the sign-ins", () => {
    const lines = [
      ask("2026-10-20T08:00:01Z", "203.0.113.5", 302),
      `2026-10-20T08:00:02.123456789Z ${ask("2026-10-20T08:00:02Z", "203.0.113.5", 200)}`,
      ask("2026-10-20T08:10:00Z", "198.51.100.9", 401),
      "2026-10-20T08:10:05Z INF Request client_ip=203.0.113.5 method=POST path=/api/user/login status=200",
      "2026-10-20T08:11:05Z INF Request client_ip=198.51.100.9 method=POST path=/api/user/login status=401",
      '2026-10-20T08:12:00Z ERR Failed to read users file error="no such file"',
      "2026-10-20T08:13:00Z WRN Client Error client_ip=198.51.100.9 path=/api/auth/caddy status=401",
    ];
    const p = parseTinyauthLog(lines);
    expect(p.checks).toEqual({ allowed: 1, sentToSignIn: 1, refused: 2 });
    expect(p.signIns).toEqual([
      { at: "2026-10-20T08:11:05Z", address: "198.51.100.9", ok: false },
      { at: "2026-10-20T08:10:05Z", address: "203.0.113.5", ok: true },
    ]);
    expect(p.addresses[0]).toMatchObject({ address: "203.0.113.5", allowed: 1, sentToSignIn: 1 });
    expect(p.errors).toHaveLength(1);
    expect(p.errors[0]!.text).toMatch(/Failed to read users file/);
    expect(p.from).toBe("2026-10-20T08:00:01Z");
    expect(p.hours).toEqual([{ hour: "2026-10-20T08:00:00Z", checks: 4 }]);
  });

  it("flags an hour far busier than usual, and who made it", () => {
    const lines: string[] = [];
    for (let h = 0; h < 10; h++)
      for (let i = 0; i < 60; i++)
        lines.push(ask(`2026-10-20T0${h}:${String(i).padStart(2, "0")}:00Z`, "203.0.113.5", 302));
    for (let i = 0; i < 3000; i++) lines.push(ask("2026-10-20T11:30:00Z", "66.0.0.1", 200));
    const p = parseTinyauthLog(lines.sort());
    expect(p.bursts).toEqual([
      { hour: "2026-10-20T11:00:00Z", checks: 3000, mostly: "66.0.0.1", signedIn: true },
    ]);
  });

  it("reads an empty log as nothing happened", () => {
    expect(parseTinyauthLog([])).toMatchObject({
      checks: { allowed: 0, sentToSignIn: 0, refused: 0 },
      signIns: [],
      bursts: [],
    });
  });
});
