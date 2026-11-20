import { describe, expect, it } from "vitest";
import { fitsNeed, needOf } from "./broker";

/** Which saved credential fits a service: a login app takes a login; RomM a token too. */
describe("fitsNeed", () => {
  const login = { kind: "login" as const, username: "hearth" };
  const token = { kind: "api-key" as const, username: null };
  it("a login app takes a login, not a key", () => {
    const qb = needOf({ name: "qBittorrent", image: "linuxserver/qbittorrent" });
    expect(fitsNeed(qb, login)).toBe(true);
    expect(fitsNeed(qb, token)).toBe(false);
  });
  it("RomM takes a login or, read only, a token; its database is not RomM", () => {
    const romm = needOf({ name: "RomM", image: "rommapp/romm:latest" });
    expect(romm).toMatchObject({ kind: "login", tokenToo: true });
    expect(fitsNeed(romm, login)).toBe(true);
    expect(fitsNeed(romm, token)).toBe(true);
    expect(needOf({ name: "romm-db", image: "mariadb:latest" })).toBeUndefined();
  });
  it("a key app takes a key, not a login", () => {
    const radarr = needOf({ name: "Radarr", image: "linuxserver/radarr" });
    expect(fitsNeed(radarr, token)).toBe(true);
    expect(fitsNeed(radarr, login)).toBe(false);
  });
});
