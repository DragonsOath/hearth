import { describe, expect, it } from "vitest";
import { sanitizeConfig } from "./container-config";
import { MAX_LIMIT, SCAN_LINES, parseWhen, planLogQuery, shapeLogLines } from "./log-query";
import { toLogLines } from "./tools";

const NOW = Date.parse("2026-10-09T12:00:00Z") / 1000;

describe("log windows", () => {
  it("reads relative and absolute times", () => {
    expect(parseWhen("90m", NOW)).toBe(NOW - 5400);
    expect(parseWhen("3d", NOW)).toBe(NOW - 3 * 86400);
    expect(parseWhen("2026-10-09T11:00:00Z", NOW)).toBe(NOW - 3600);
    expect(() => parseWhen("last tuesday", NOW)).toThrow(/is not a time/);
  });

  it("bounds the window, the limit, and the filter", () => {
    const p = planLogQuery({ since: "90d", limit: 10_000, filter: "x".repeat(300) }, NOW);
    expect(p.range.since).toBe(NOW - 30 * 86400);
    expect(p.window).toContain("30-day limit");
    expect(p.limit).toBe(MAX_LIMIT);
    expect(p.filter).toHaveLength(100);
    expect(() => planLogQuery({ since: "1h", until: "2h" }, NOW)).toThrow(/before its end/);
  });

  it("filters as plain text after redaction and says when the scan was capped", () => {
    const plan = planLogQuery({ since: "1h", filter: "a.b", limit: 2 }, NOW);
    const out = shapeLogLines(["axb", "a.b one", "a.b two", "a.b three"], plan);
    expect(out[0]).toBe(
      `(4 lines in 2026-10-09 11:00 UTC to now, 3 containing "a.b", showing the latest 2)`,
    );
    expect(out.slice(1)).toEqual(["a.b two", "a.b three"]);
    const capped = shapeLogLines(
      Array(SCAN_LINES).fill("line"),
      planLogQuery({ since: "1h" }, NOW),
    );
    expect(capped[1]).toMatch(/Only the latest/);
  });

  it("keeps Docker's time on each line, to the second, and still hides secrets", () => {
    const lines = toLogLines(
      "2026-10-09T11:59:01.123456789Z GET /api?apikey=0123456789abcdef0123456789abcdef\n",
      10,
      true,
    );
    expect(lines[0]).toMatch(/^2026-10-09T11:59:01Z GET \/api\?apikey=/);
    expect(lines[0]).not.toContain("0123456789abcdef0123456789abcdef");
  });
});

describe("container configuration", () => {
  it("keeps environment names only and leaves out commands and labels", () => {
    const c = sanitizeConfig({
      Image: "sha256:abcdef1234567890",
      Config: {
        Image: "lscr.io/linuxserver/qbittorrent:latest",
        Env: ["WEBUI_PASSWORD=hunter2", "TZ=America/Phoenix", "TZ=dup"],
        Labels: { "com.docker.compose.project": "media", secret: "label-secret" },
        Healthcheck: { Test: ["CMD", "curl", "-u", "admin:pw", "x"], Interval: 30e9, Retries: 3 },
      },
      HostConfig: {
        RestartPolicy: { Name: "unless-stopped" },
        Memory: 512 * 1048576,
        CapAdd: ["NET_ADMIN"],
      },
      NetworkSettings: {
        Ports: { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "8090" }], "6881/udp": null },
        Networks: { media: {} },
      },
      Mounts: [
        { Type: "bind", Source: "/srv/homelab/docker/qb", Destination: "/config", RW: false },
      ],
    });
    const json = JSON.stringify(c);
    expect(c.environmentNames).toEqual(["TZ", "WEBUI_PASSWORD"]);
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("admin:pw");
    expect(json).not.toContain("label-secret");
    expect(c).toMatchObject({
      imageId: "abcdef123456",
      restartPolicy: "unless-stopped",
      healthCheck: { configured: true, intervalSeconds: 30, retries: 3 },
      ports: ["8090 -> 8080/tcp", "6881/udp (not published)"],
      networks: ["media"],
      limits: { memoryMb: 512 },
      composeProject: "media",
      addedCapabilities: ["NET_ADMIN"],
      mounts: [{ source: "/srv/homelab/docker/qb", destination: "/config", readOnly: true }],
    });
  });
});
