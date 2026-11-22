import { describe, expect, it } from "vitest";
import { buildDoneText, type HomelabStep } from "./homelab-build";

const step = (id: HomelabStep["id"], name: string): HomelabStep => ({
  id,
  name,
  what: "",
  status: "done",
});

describe("Ember's congratulations when the build is done (11-22)", () => {
  it("says everything is built, what was built, and the first thing to try", () => {
    const text = buildDoneText({
      steps: [
        step("docker", "Docker"),
        step("jellyfin", "Jellyfin"),
        step("seerr", "Seerr"),
        step("radarr", "Radarr"),
        step("connect", "Connect the apps"),
        step("tailscale", "Tailscale"),
      ],
    });
    expect(text).toMatch(/^Congratulations, everything is built!/);
    expect(text).toContain("Jellyfin, Seerr and Radarr: each one set up");
    expect(text).not.toContain("Docker");
    expect(text).toContain("open Jellyfin and play something");
    expect(text).toContain("ask for a movie in Seerr");
    expect(text).toContain("Tailscale");
    expect(text).not.toMatch(/—/);
  });

  it("without a media app or Seerr, still congratulates", () => {
    const text = buildDoneText({ steps: [step("docker", "Docker"), step("radarr", "Radarr")] });
    expect(text).toMatch(/^Congratulations, everything is built!/);
    expect(text).not.toContain("Try this first");
    expect(text).not.toContain("Seerr");
  });
});
