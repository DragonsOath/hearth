import { describe, expect, it } from "vitest";
import { notificationsDown } from "./arr";

// 11-13: a Discord webhook deleted in Discord left Radarr warning "Notifications unavailable".
describe("notificationsDown", () => {
  it("names the connection, the likely cause and the fix in plain words", () => {
    const text = notificationsDown(
      "Radarr",
      "Notifications unavailable due to failures: Home Vault Discord",
    );
    expect(text).toContain(`Radarr can't send through "Home Vault Discord"`);
    expect(text).toContain("deleted in Discord");
    expect(text).toContain("Ask Ember to plan either.");
    expect(notificationsDown("Sonarr", undefined)).toContain("a notification connection");
  });
});
