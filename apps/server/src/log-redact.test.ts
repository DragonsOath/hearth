import { describe, expect, it } from "vitest";
import { logRequest, redactUrl } from "./log-redact";

describe("request logs", () => {
  it("never keep sign-in codes or tokens", () => {
    expect(redactUrl("/api/home/music-assistant/back?state=abc&code=eyJhbGci.x.y")).toBe(
      "/api/home/music-assistant/back?state=%5Bredacted%5D&code=%5Bredacted%5D",
    );
    expect(redactUrl("/api/home/music?page=2")).toBe("/api/home/music?page=2");
    expect(redactUrl("/plain")).toBe("/plain");
    expect(logRequest({ method: "GET", url: "/x?token=1" }).url).not.toContain("=1");
  });
});
