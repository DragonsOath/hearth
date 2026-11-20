import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  cleanAddress,
  MusicAssistantLink,
  plainYoutubeError,
  reachableAddress,
  youtubeCookieHeader,
  type ChromeRunner,
} from "./music-assistant-link";

// Music Assistant from Hearth (11-05): its own sign-in returns a session, Hearth finishes its
// setup, and YouTube Music is added from an ordinary Chrome window's sign-in, never shown.

const MA = "http://192.168.1.50:8095";

function fakeMa(opts: { premium?: boolean } = {}) {
  const calls: { command: string; args: Record<string, unknown>; auth: string }[] = [];
  let onboarded = false;
  let flow = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u === `${MA}/info`)
      return new Response(JSON.stringify({ server_version: "2.10.9", onboard_done: onboarded }));
    if (u === `${MA}/api`) {
      const b = JSON.parse(String(init?.body)) as {
        command: string;
        args: Record<string, unknown>;
      };
      const auth = String((init?.headers as Record<string, string>).authorization);
      calls.push({ ...b, auth });
      if (auth !== "Bearer ma-session-token")
        return new Response("Not authenticated", { status: 401 });
      if (b.command === "config/onboard_complete") {
        onboarded = true;
        return new Response("null");
      }
      if (b.command === "config/providers/setup")
        return new Response(
          JSON.stringify({ flow_id: `f${++flow}`, step_id: "user", type: "form" }),
        );
      if (b.command === "config/flows/submit") {
        const v = b.args.values as Record<string, string>;
        if (!/__Secure-3PAPISID=/.test(v.cookie ?? ""))
          return new Response(
            JSON.stringify({ type: "form", errors: { base: "cookies_expired" } }),
          );
        if (opts.premium === false)
          return new Response(JSON.stringify({ type: "form", errors: { base: "no_premium" } }));
        return new Response(JSON.stringify({ type: "finish", flow_id: b.args.flow_id }));
      }
      if (b.command === "config/flows/abort") return new Response("null");
      // One YouTube Music there already (the wrong account), replaced by the new one.
      if (b.command === "config/providers")
        return new Response(JSON.stringify([{ instance_id: "ytmusic--old" }]));
      if (b.command === "config/providers/remove") return new Response("null");
      return new Response(`Invalid Command: ${b.command}`, { status: 400 });
    }
    // YouTube Music's own page: the channels this sign-in can play as.
    if (u.startsWith("https://music.youtube.com/youtubei/v1/account/accounts_list")) {
      const h = init?.headers as Record<string, string>;
      if (!/^SAPISIDHASH \d+_[0-9a-f]{40}$/.test(h.Authorization ?? ""))
        return new Response("no", { status: 401 });
      const account = (name: string, byline: string, pageId?: string) => ({
        accountItem: {
          accountName: { simpleText: name },
          accountByline: { simpleText: byline },
          serviceEndpoint: {
            selectActiveIdentityEndpoint: {
              supportedTokens: [
                { accountStateToken: { hasChannel: true } },
                ...(pageId ? [{ pageIdToken: { pageId } }] : []),
              ],
            },
          },
        },
      });
      return new Response(
        JSON.stringify({
          actions: [
            {
              getMultiPageMenuAction: {
                menu: {
                  multiPageMenuRenderer: {
                    sections: [
                      {
                        accountSectionListRenderer: {
                          contents: [
                            {
                              accountItemSectionRenderer: {
                                contents: [
                                  account("JP", "@jp", "107382491788380048492"),
                                  account("Alex", "me@example.com"),
                                ],
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        }),
      );
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls, onboarded: () => onboarded };
}

function fakeChrome(cookies: { name: string; value: string; domain: string }[]) {
  const opened: string[] = [];
  const chrome: ChromeRunner = {
    openWindow: (_profile, url) => {
      opened.push(url);
      return { kill: () => true } as unknown as ChildProcess;
    },
    readCookies: async () => cookies,
  };
  return { chrome, opened };
}

const profiles = () => mkdtempSync(path.join(tmpdir(), "hearth-ma-test-"));

describe("Music Assistant from Hearth", () => {
  it("cleans the address (a bare host gets port 8095)", () => {
    expect(cleanAddress("192.168.1.50")).toBe(MA);
    expect(cleanAddress(" http://192.168.1.50:8095/ ")).toBe(MA);
    expect(cleanAddress("https://music.example.com")).toBe("https://music.example.com");
  });

  it("gives Home Assistant a home-network address instead of this machine's own names", async () => {
    const via = async () => "192.168.1.50";
    const ha = "http://192.168.1.10:8123";
    expect(await reachableAddress("http://127.0.0.1:8095", ha, via)).toBe(MA);
    expect(await reachableAddress("http://localhost:8095", ha, via)).toBe(MA);
    expect(await reachableAddress("http://homeassistant.local:8095", ha, via)).toBe(MA);
    expect(await reachableAddress("http://192.168.1.9:8095", ha, via)).toBe(
      "http://192.168.1.9:8095",
    );
    expect(await reachableAddress("http://127.0.0.1:8095", ha, async () => undefined)).toBe(
      "http://127.0.0.1:8095",
    );
  });

  it("builds YouTube's sign-in from the profile's YouTube cookies only", () => {
    const r = youtubeCookieHeader([
      { name: "SID", value: "a", domain: ".youtube.com" },
      { name: "__Secure-3PAPISID", value: "b", domain: ".youtube.com" },
      { name: "NID", value: "c", domain: ".google.com" },
      { name: "SID", value: "dup", domain: "music.youtube.com" },
    ]);
    expect(r).toEqual({ header: "SID=a; __Secure-3PAPISID=b", signedIn: true });
    expect(
      youtubeCookieHeader([{ name: "PREF", value: "x", domain: ".youtube.com" }]).signedIn,
    ).toBe(false);
  });

  it("signs in through Music Assistant's own page, finishes its setup, adds YouTube Music", async () => {
    const ma = fakeMa();
    const { chrome, opened } = fakeChrome([
      { name: "SID", value: "secret-sid", domain: ".youtube.com" },
      { name: "__Secure-3PAPISID", value: "secret-papisid", domain: ".youtube.com" },
    ]);
    const link = new MusicAssistantLink(profiles(), ma.fetchImpl, chrome);
    const s = await link.start("192.168.1.50", "http://hearth.test/api/home/music-assistant/back");
    expect(s.loginUrl).toMatch(/^http:\/\/192\.168\.1\.50:8095\/login\?return_url=/);
    expect(decodeURIComponent(s.loginUrl)).toContain(`back?state=${s.state}`);
    expect(link.status(s.state).signedIn).toBe(false);
    await expect(link.finishSetup(s.state)).rejects.toThrow(/Sign in to Music Assistant first/);

    link.back(s.state, "ma-session-token");
    expect(link.status(s.state).signedIn).toBe(true);
    await link.finishSetup(s.state);
    expect(ma.onboarded()).toBe(true);
    expect(link.forHomeAssistant(s.state)).toEqual({ address: MA, token: "ma-session-token" });

    link.openYoutube(s.state);
    expect(opened).toEqual(["https://music.youtube.com"]);
    const read = await link.youtubeRead(s.state);
    // The channels to pick from: the person's own first, then the brand channel.
    expect(read).toEqual({
      signedIn: true,
      channels: [
        { name: "Alex", byline: "me@example.com" },
        { id: "107382491788380048492", name: "JP", byline: "@jp" },
      ],
    });
    expect(link.status(s.state).youtubeOpen).toBe(false);
    const r = await link.youtubeDone(s.state, { id: "107382491788380048492", name: "JP" });
    expect(r).toEqual({
      added: true,
      cookie: "SID=secret-sid; __Secure-3PAPISID=secret-papisid",
      channel: "107382491788380048492",
    });
    // The old YouTube Music goes once the new one works.
    expect(ma.calls.map((c) => c.command)).toContain("config/providers/remove");
    const submit = ma.calls.find((c) => c.command === "config/flows/submit")!;
    expect(submit.args.values).toMatchObject({
      username: "107382491788380048492",
      cookie: "SID=secret-sid; __Secure-3PAPISID=secret-papisid",
      po_token_server_url: "http://127.0.0.1:4416",
    });
    // The setup forgets it once handed over (Hearth keeps it in Secure Vault, not here).
    await expect(link.youtubeDone(s.state, { name: "Alex" })).rejects.toThrow(/Sign in to YouTube/);
  }, 15_000);

  it("opens the window again when it was not signed in, and says when Premium is missing", async () => {
    const notSigned = fakeChrome([{ name: "PREF", value: "x", domain: ".youtube.com" }]);
    const ma = fakeMa();
    const link = new MusicAssistantLink(profiles(), ma.fetchImpl, notSigned.chrome);
    const s = await link.start(MA, "http://hearth.test/back");
    link.back(s.state, "ma-session-token");
    link.openYoutube(s.state);
    const r = await link.youtubeRead(s.state);
    expect(r.signedIn).toBe(false);
    expect(!r.signedIn && r.message).toMatch(/wasn't signed in/);
    expect(notSigned.opened).toHaveLength(2);

    const noPremium = fakeMa({ premium: false });
    const signed = fakeChrome([{ name: "__Secure-3PAPISID", value: "b", domain: ".youtube.com" }]);
    const link2 = new MusicAssistantLink(profiles(), noPremium.fetchImpl, signed.chrome);
    const s2 = await link2.start(MA, "http://hearth.test/back");
    link2.back(s2.state, "ma-session-token");
    link2.openYoutube(s2.state);
    await link2.youtubeRead(s2.state);
    expect(await link2.youtubeDone(s2.state, { name: "Alex" })).toEqual({
      added: false,
      message: expect.stringMatching(/Premium/),
    });
    expect(noPremium.calls.some((c) => c.command === "config/flows/abort")).toBe(true);
  }, 20_000);

  it("refuses an address with no Music Assistant, and an unknown or ended setup", async () => {
    const link = new MusicAssistantLink(profiles(), fakeMa().fetchImpl, fakeChrome([]).chrome);
    await expect(link.start("http://10.0.0.9:8095", "http://h/back")).rejects.toThrow(
      /No Music Assistant answers/,
    );
    expect(() => link.back("made-up", "ma-session-token")).toThrow(/ended/);
    const s = await link.start(MA, "http://h/back");
    link.end(s.state);
    expect(() => link.status(s.state)).toThrow(/ended/);
    expect(plainYoutubeError("po_token_server_unreachable")).toMatch(/token helper/);
  });
});
