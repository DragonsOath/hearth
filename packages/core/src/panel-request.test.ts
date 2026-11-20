import { describe, expect, it } from "vitest";
// The matcher the "Panel requests" workflow runs on every new issue.
import { isPanelRequest } from "../../../.github/scripts/panel-request.mjs";

describe("which issues are panel requests (moved to the request board)", () => {
  it("matches clear requests for a new panel", () => {
    for (const title of [
      "Panel: Navidrome",
      "[Panel request] Frigate",
      "Panel request: Gitea",
      "Add a panel for Mealie",
      "Please add a full panel for Paperless-ngx",
      "Request panel for Komga",
      "Panel for Actual Budget",
      "Feature request: panel for Forgejo",
    ])
      expect(isPanelRequest(title, "It would be great to see my stuff."), title).toBe(true);
  });

  it("never matches a problem with a panel that exists", () => {
    for (const [title, body] of [
      ["Panel: Uptime Kuma shows nothing", "The Monitors tab is blank."],
      ["Panel: Pi-hole", "The query log does not load since 0.9."],
      ["Add a panel for Sonarr", "Sonarr panel is broken after the update"],
      ["Portainer panel crashes", ""],
      ["Panel for Radarr: wrong poster", ""],
      ["The panel for Plex is missing", ""],
      ["Bug: panel for Traefik", ""],
    ] as [string, string][])
      expect(isPanelRequest(title, body), title).toBe(false);
  });

  it("leaves anything unsure, or marked a bug, as an issue", () => {
    expect(isPanelRequest("Navidrome support?", "")).toBe(false);
    expect(isPanelRequest("Can Hearth show my Gitea repos", "")).toBe(false);
    expect(isPanelRequest("Panel: Navidrome", "", ["bug"])).toBe(false);
  });
});
