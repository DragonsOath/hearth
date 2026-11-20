import { describe, expect, it } from "vitest";
import { appKindOf } from "./apps";

describe("which app a service is", () => {
  it("knows an app by its image, its name, or its name with a note in brackets", () => {
    expect(appKindOf({ name: "media", image: "lscr.io/linuxserver/plex:latest" })).toBe("plex");
    expect(appKindOf({ name: "Plex" })).toBe("plex");
    // Added by hand with a note (the Forge acceptance run found this refused as "not Plex").
    expect(appKindOf({ name: "Plex (test)" })).toBe("plex");
    expect(appKindOf({ name: "Radarr (4K)" })).toBe("radarr");
    // Other things with the word in them are not that app.
    expect(appKindOf({ name: "Plex Meta Manager" })).toBeUndefined();
    expect(appKindOf({ name: "Notes (plex ideas)" })).toBeUndefined();
  });

  it("knows Nextcloud, and not its database, cron, Redis or AIO's other containers", () => {
    expect(appKindOf({ name: "cloud", image: "nextcloud:31-apache" })).toBe("nextcloud");
    expect(appKindOf({ name: "x", image: "lscr.io/linuxserver/nextcloud:latest" })).toBe(
      "nextcloud",
    );
    expect(appKindOf({ name: "x", image: "nextcloud/aio-nextcloud:latest" })).toBe("nextcloud");
    expect(appKindOf({ name: "Nextcloud" })).toBe("nextcloud");
    for (const image of ["nextcloud/aio-apache", "nextcloud/all-in-one:latest", "mariadb:11"])
      expect(appKindOf({ name: "x", image })).toBeUndefined();
    expect(
      appKindOf({ name: "nextcloud-cron", image: "rcdailey/nextcloud-cronjob" }),
    ).toBeUndefined();
    expect(appKindOf({ name: "nextcloud-db", image: "postgres:16" })).toBeUndefined();
  });
});
