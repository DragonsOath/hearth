import { describe, expect, it } from "vitest";
import { CATALOG } from "./catalog";
import { findAppsAt, identifyPage, type PageRead } from "./analyze";
import { runRemoteDiscovery } from "./scan";

/** Another machine's pages, as a NAS running apps in Docker answers them. */
const page = (title: string, extra: Partial<PageRead> = {}): PageRead => ({
  status: 200,
  headers: {},
  body: title
    ? `<!doctype html><html><head><title>${title}</title></head><body></body></html>`
    : "",
  ...extra,
});
const on = (port: number) =>
  CATALOG.filter((e) => !e.supporting && (e.nativePort ?? e.webPort) === port);
const idOf = (p: PageRead, port: number) => identifyPage(p, on(port))?.id;

describe("telling apps apart by their own page", () => {
  it("reads the app from its title, even on a port several apps share", () => {
    expect(idOf(page("Login - Radarr"), 7878)).toBe("radarr");
    expect(idOf(page("qBittorrent WebUI"), 8080)).toBe("qbittorrent");
    expect(idOf(page("SABnzbd"), 8080)).toBe("sabnzbd");
    expect(idOf(page("Emby"), 8096)).toBe("emby");
    expect(idOf(page("Jellyfin"), 8096)).toBe("jellyfin");
    expect(idOf(page("Tautulli - Login"), 8181)).toBe("tautulli");
  });

  it("knows Seerr (Jellyseerr's successor), and never mistakes Jellyseerr for Overseerr", () => {
    expect(idOf(page("Seerr"), 5055)).toBe("jellyseerr");
    expect(idOf(page("Jellyseerr"), 5055)).toBe("jellyseerr");
    expect(idOf(page("Overseerr"), 5055)).toBe("overseerr");
  });

  it("knows Plex and Transmission by their headers", () => {
    expect(
      idOf(page("Unauthorized", { status: 401, headers: { "x-plex-protocol": "1.0" } }), 32400),
    ).toBe("plex");
    expect(
      idOf(page("", { status: 409, headers: { "x-transmission-session-id": "abc" } }), 9091),
    ).toBe("transmission");
  });

  it("finds an app named only in its page, on its own port", () => {
    expect(
      idOf(page("", { body: '<html><script src="/immich/app.js"></script>Immich' }), 2283),
    ).toBe("immich");
  });

  it("names nothing when the page is someone else's", () => {
    expect(idOf(page("Arr Control Center"), 3000)).toBeUndefined();
    expect(idOf(page("My homepage"), 8080)).toBeUndefined();
  });
});

describe("scanning another machine", () => {
  const nas = (pages: Record<number, PageRead>) =>
    findAppsAt({
      hostId: "nas",
      hostName: "NAS",
      address: "192.168.1.20",
      probeHttp: async () => false,
      readPage: async (port) => pages[port] ?? null,
    });

  it("finds the NAS itself and every app on it, from one address", async () => {
    const found = await nas({
      5000: page("Synology DiskStation - nas"),
      8989: page("Login - Sonarr"),
      7878: page("Login - Radarr"),
      8080: page("qBittorrent WebUI"),
      5055: page("Seerr"),
      32400: page("Unauthorized", { status: 401, headers: { "x-plex-protocol": "1.0" } }),
    });
    expect(found.map((f) => [f.name, f.localUrl])).toEqual([
      ["Synology DSM", "http://192.168.1.20:5000"],
      ["Jellyseerr", "http://192.168.1.20:5055"],
      ["Radarr", "http://192.168.1.20:7878"],
      ["qBittorrent", "http://192.168.1.20:8080"],
      ["Sonarr", "http://192.168.1.20:8989"],
      ["Plex", "http://192.168.1.20:32400"],
    ]);
    expect(found.every((f) => f.localOnly === false && f.selectedByDefault)).toBe(true);
    expect(found[0]).toMatchObject({ category: "Files & Photos", autonomyArea: "storage" });
  });

  it("keeps Kavita on port 5000 when the page is Kavita's, not a Synology's", async () => {
    const found = await nas({ 5000: page("Kavita") });
    expect(found.map((f) => f.name)).toEqual(["Kavita"]);
  });

  it("recognises QNAP, TrueNAS, Unraid and OpenMediaVault by their sign-in pages", async () => {
    expect((await nas({ 8080: page("QTS") })).map((f) => f.name)).toEqual(["QNAP QTS"]);
    expect((await nas({ 80: page("TrueNAS") })).map((f) => f.name)).toEqual(["TrueNAS"]);
    expect(
      (await nas({ 80: page("Tower/Login", { body: "<title>Tower/Login</title>unraid" }) })).map(
        (f) => f.name,
      ),
    ).toEqual(["Unraid"]);
    expect((await nas({ 80: page("openmediavault control panel") })).map((f) => f.name)).toEqual([
      "OpenMediaVault",
    ]);
  });

  it("falls back to the port for an unbranded page on a port only one app uses", async () => {
    expect((await nas({ 8384: page("") })).map((f) => f.name)).toEqual(["Syncthing"]);
  });

  it("finds an app published on its usual host port as well as its container port", async () => {
    expect((await nas({ 13378: page("Audiobookshelf") })).map((f) => f.localUrl)).toEqual([
      "http://192.168.1.20:13378",
    ]);
  });

  it("without page reads, finds only the apps with a port of their own, as before", async () => {
    const report = await runRemoteDiscovery(
      { probeHttp: async (port) => port === 8096 || port === 8080 },
      { address: "192.168.1.20", name: "NAS" },
    );
    expect(report.findings.map((f) => f.name)).toEqual(["Jellyfin"]);
  });
});
