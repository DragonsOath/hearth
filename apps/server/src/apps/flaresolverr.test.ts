import { describe, expect, it } from "vitest";
import { parseFlareLog } from "./flaresolverr";

/** FlareSolverr's panel is read from its own log; these lines are copied from a real 3.5 log. */

const LOG = [
  "2026-10-20 01:00:00 INFO     FlareSolverr 3.5.2",
  "2026-10-20 09:41:20 INFO     Incoming request => POST /v1 body: {'maxTimeout': 60000, 'cmd': 'request.get', 'url': 'https://publictracker.example/cat/Movies/1/', 'proxy': {}}",
  "2026-10-20 09:41:21 INFO     Challenge detected. Title found: Just a moment...",
  "2026-10-20 09:41:52 INFO     Challenge solved!",
  "2026-10-20 09:41:52 INFO     Response in 32.241 s",
  "2026-10-20 09:41:52 INFO     127.0.0.1 POST http://localhost:8191/v1 200 OK",
  "2026-10-20 11:37:40 INFO     Incoming request => POST /v1 body: {'maxTimeout': 60000, 'cmd': 'request.get', 'url': 'https://prowlarr.servarr.com/v1/ping', 'proxy': {}}",
  "2026-10-20 11:37:41 INFO     Challenge not detected!",
  "2026-10-20 11:37:42 INFO     Response in 1.16 s",
  "2026-10-20 12:00:00 INFO     Incoming request => POST /v1 body: {'maxTimeout': 60000, 'cmd': 'request.get', 'url': 'https://publictracker.example/search/x/1/', 'proxy': {}}",
  "2026-10-20 12:01:00 ERROR    Error: Error solving the challenge. Timeout after 60.0 seconds.",
  "2026-10-20 12:01:00 INFO     Response in 60.1 s",
  "2026-10-20 13:21:57 INFO     Incoming request => POST /v1 body: {'cmd': 'sessions.list'}",
  "2026-10-20 13:21:57 INFO     Response in 0.0 s",
];

describe("the FlareSolverr panel", () => {
  it("reads each request's site, verdict, and time from the log, newest first", () => {
    const p = parseFlareLog(LOG);
    expect(p.version).toBe("3.5.2");
    expect(p.requests.map((r) => [r.site, r.outcome, r.seconds])).toEqual([
      ["publictracker.example", "failed", 60.1],
      ["prowlarr.servarr.com", "no-challenge", 1.16],
      ["publictracker.example", "solved", 32.241],
    ]);
    expect(p.requests[0]?.why).toBe(
      "Error: Error solving the challenge. Timeout after 60.0 seconds.",
    );
  });

  it("sums up per site, failures first, and leaves out its own session housekeeping", () => {
    const p = parseFlareLog(LOG);
    expect(p.sites).toEqual([
      { site: "publictracker.example", requests: 2, solved: 1, failed: 1, avgSeconds: 46.2 },
      { site: "prowlarr.servarr.com", requests: 1, solved: 0, failed: 0, avgSeconds: 1.2 },
    ]);
  });
});
