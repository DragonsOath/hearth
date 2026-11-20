import { describe, expect, it } from "vitest";
import { mayGoTo } from "../credentials/broker";
import { fakePlex } from "./fake-plex";
import { readPlexAccess } from "./plex-access";

// Who has access to this Plex server, read from plex.tv (the Plex panel's Manage tab).

describe("Plex: who has access", () => {
  it("lists friends and Home members with how many libraries, never emails or access keys", async () => {
    const plex = fakePlex();
    const got = await readPlexAccess(plex.fetch, "http://10.0.0.9:32400", "e2e-plex", "hearth-id");
    expect(got.server).toBe("Sample Plex");
    const by = Object.fromEntries(got.friends.map((f) => [f.name, f]));
    expect(Object.keys(by)).toEqual(["Kids", "Alex Rivers", "Jordan", "sam"]);
    expect(by["Alex Rivers"]).toMatchObject({ allLibraries: true, numLibraries: 2 });
    expect(by["sam"]).toMatchObject({ allLibraries: false, libraries: ["TV Shows"] });
    expect(by["Jordan"]!.pending).toBe(true);
    expect(by["Kids"]).toMatchObject({ home: true, restricted: true });
    // Someone with another server only is not listed.
    expect(by["Elsewhere"]).toBeUndefined();
    const text = JSON.stringify(got);
    expect(text).not.toContain("never-shown");
    expect(text).not.toContain("@example.com");
  });

  it("the Plex token goes to plex.tv only for a Plex server, and only when asked for", () => {
    const plex = { name: "Plex", image: "plexinc/pms-docker", localUrl: "http://10.0.0.9:32400" };
    expect(mayGoTo(plex, null, "https://plex.tv/api/users/", "plex.tv")).toBe(true);
    expect(mayGoTo(plex, null, "https://plex.tv/api/users/")).toBe(false);
    expect(mayGoTo(plex, null, "http://10.0.0.9:32400/identity")).toBe(true);
    expect(mayGoTo(plex, null, "https://evil.example/", "plex.tv")).toBe(false);
    const tautulli = {
      name: "Tautulli",
      image: "tautulli/tautulli",
      localUrl: "http://10.0.0.9:8181",
    };
    expect(mayGoTo(tautulli, null, "https://plex.tv/api/users/", "plex.tv")).toBe(false);
    const radarr = {
      name: "Radarr",
      image: "linuxserver/radarr",
      localUrl: "http://10.0.0.9:7878",
    };
    expect(mayGoTo(radarr, null, "https://plex.tv/", "plex.tv")).toBe(false);
  });
});
