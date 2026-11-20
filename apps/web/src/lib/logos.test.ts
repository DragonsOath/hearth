import { describe, expect, it } from "vitest";
import { logoFor } from "./logos";

describe("logoFor", () => {
  it.each([
    ["Radarr", "lscr.io/linuxserver/radarr:latest", "radarr.svg"],
    ["PostgreSQL (immich_postgres)", "ghcr.io/immich-app/postgres:14", "postgres.svg"],
    ["Redis (immich_redis)", "docker.io/valkey/valkey:8", "redis.svg"],
    ["Immich machine learning", "ghcr.io/immich-app/immich-machine-learning:release", "immich.svg"],
    ["MariaDB (romm-db)", "mariadb:latest", "mariadb.svg"],
    ["Jellyseerr", undefined, "jellyseerr.svg"],
    ["Overseerr", undefined, "overseerr.svg"],
    ["Seerr", undefined, "seerr.svg"],
    ["Plex (plex-test)", undefined, "plex.svg"],
    ["Gluetun VPN (gluetun-qbit)", undefined, "gluetun.svg"],
    ["RustDesk relay (hbbs)", undefined, "rustdesk.svg"],
    ["Ha Ui", "ha-ui-ha-ui", "home-assistant.svg"],
    ["Collection Pdf Server", "nginx:alpine", "nginx.svg"],
    ["Nanohive Abs Theme", undefined, "audiobookshelf.svg"],
    ["Windows host", undefined, "windows-11.svg"],
    ["Docker", undefined, "docker.svg"],
  ])("%s gets %s", (name, image, file) => {
    expect(logoFor(name, image)).toBe(`/logos/${file}`);
  });

  it("leaves services without a logo to their letters", () => {
    expect(logoFor("Romarr", "ghcr.io/blizzhacker/romarr:latest")).toBeUndefined();
    expect(logoFor("Arr Dashboard", "khak1s/arr-dashboard:latest")).toBeUndefined();
    expect(logoFor("Web endpoint")).toBeUndefined();
    expect(
      logoFor("Audiobook Organizer", "audiobook-organizer-audiobook-organizer"),
    ).toBeUndefined();
  });

  it("points only at files that exist", async () => {
    const { readdirSync } = await import("node:fs");
    const files = new Set(readdirSync(new URL("../../public/logos", import.meta.url)));
    for (const n of ["Radarr", "Kometa", "Linux host", "Chaptarr", "qui", "Opnform Api"])
      expect(files.has(logoFor(n)!.slice("/logos/".length))).toBe(true);
  });
});
