import { describe, expect, it } from "vitest";
import type { Fetch } from "./http";
import { authHeaders, youtubeChannels, youtubeHome, YoutubeSignedOut } from "./youtube-music";

// YouTube Music read with the owner's sign-in (11-05): the home page's rows in YouTube's order
// with Speed dial first (the owner: "Speed dial", "Quick picks... the 2 I care about"), as Music
// Assistant addresses; and the channels the sign-in can play as.

const COOKIE = "SID=s; __Secure-3PAPISID=papisid-value; HSID=h";
const PROVIDER = "ytmusic--abc123";

const two = (title: string, browseId: string, pageType: string, sub = "") => ({
  musicTwoRowItemRenderer: {
    title: { runs: [{ text: title }] },
    subtitle: { runs: [{ text: sub }] },
    thumbnailRenderer: {
      musicThumbnailRenderer: {
        thumbnail: {
          thumbnails: [
            { url: "https://lh3.googleusercontent.com/small" },
            { url: `https://lh3.googleusercontent.com/${browseId}` },
          ],
        },
      },
    },
    navigationEndpoint: {
      browseEndpoint: {
        browseId,
        browseEndpointContextSupportedConfigs: {
          browseEndpointContextMusicConfig: { pageType },
        },
      },
    },
  },
});
const song = (title: string, by: string, videoId: string) => ({
  musicResponsiveListItemRenderer: {
    thumbnail: {
      musicThumbnailRenderer: {
        thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${videoId}/hq.jpg` }] },
      },
    },
    flexColumns: [
      {
        musicResponsiveListItemFlexColumnRenderer: {
          text: { runs: [{ text: title, navigationEndpoint: { watchEndpoint: { videoId } } }] },
        },
      },
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: by }] } } },
    ],
    playlistItemData: { videoId },
  },
});
const shelf = (title: string, contents: unknown[]) => ({
  musicCarouselShelfRenderer: {
    header: { musicCarouselShelfBasicHeaderRenderer: { title: { runs: [{ text: title }] } } },
    contents,
  },
});

const HOME = {
  contents: {
    singleColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              sectionListRenderer: {
                contents: [
                  shelf("Quick picks", [
                    song("Time To Time", "James Blunt", "aaaaaaaaaa1"),
                    song("Carry on Wayward Son", "Kansas", "bbbbbbbbbb2"),
                  ]),
                  shelf("Speed dial", [
                    two("Gone Hollywood", "MPREb_gone", "MUSIC_PAGE_TYPE_ALBUM", "Supertramp"),
                    two("Liked Music", "VLLM", "MUSIC_PAGE_TYPE_PLAYLIST"),
                    two("Warped Tour", "VLPLwarped", "MUSIC_PAGE_TYPE_PLAYLIST"),
                    two("Lana Del Rey", "UClana", "MUSIC_PAGE_TYPE_ARTIST"),
                  ]),
                  shelf("Forgotten favorites", [song("Loser", "Beck", "cccccccccc3")]),
                ],
              },
            },
          },
        },
      ],
    },
  },
};

function fakeYoutube() {
  const seen: { path: string; body: Record<string, unknown>; headers: Record<string, string> }[] =
    [];
  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    seen.push({ path: u.pathname, body, headers: init.headers });
    if (!/^SAPISIDHASH \d+_[0-9a-f]{40}$/.test(init.headers.Authorization ?? ""))
      return { ok: false, status: 401, json: async () => ({}) };
    if (u.pathname.endsWith("/browse")) return { ok: true, status: 200, json: async () => HOME };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, seen };
}

describe("YouTube Music with the owner's sign-in", () => {
  it("signs requests the way YouTube Music's page does, and needs a sign-in cookie", () => {
    const h = authHeaders(COOKIE, 1_700_000_000_000);
    expect(h.Authorization).toMatch(/^SAPISIDHASH 1700000000_[0-9a-f]{40}$/);
    expect(h.Origin).toBe("https://music.youtube.com");
    expect(() => authHeaders("PREF=x")).toThrow(YoutubeSignedOut);
  });

  it("names the website's rows like the app: Listen again is Speed dial, songs for you is Quick picks", async () => {
    const page = {
      contents: [
        shelf("Forgotten favorites", [song("Monsters", "James Blunt", "vid_monster")]),
        shelf("Listen again", [song("Loser", "Tame Impala", "vid_loser01")]),
      ],
      continuations: [{ nextContinuationData: { continuation: "more-rows" } }],
    };
    // The lower rows come in a second piece, as on the website.
    const rest = {
      continuationContents: {
        sectionListContinuation: {
          contents: [
            shelf("Trending songs for you", [song("Overthinker", "CHVRCHES", "vid_overthk")]),
          ],
        },
      },
    };
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => (urls.length === 1 ? page : rest) };
    }) as never;
    const rows = await youtubeHome(fetchImpl, { cookie: COOKIE }, PROVIDER);
    expect(rows.map((r) => r.title)).toEqual(["Speed dial", "Forgotten favorites", "Quick picks"]);
    expect(urls[1]).toContain("continuation=more-rows");
  });

  it("reads the home rows with Speed dial first, Quick picks next, as playable addresses", async () => {
    const yt = fakeYoutube();
    const rows = await youtubeHome(
      yt.fetchImpl,
      { cookie: COOKIE, channel: "107382491788380048492" },
      PROVIDER,
    );
    expect(rows.map((r) => r.title)).toEqual(["Speed dial", "Quick picks", "Forgotten favorites"]);
    expect(rows[0]!.items).toEqual([
      {
        uri: `${PROVIDER}://album/MPREb_gone`,
        kind: "album",
        name: "Gone Hollywood",
        by: "Supertramp",
        image: "https://lh3.googleusercontent.com/MPREb_gone",
      },
      expect.objectContaining({
        uri: `${PROVIDER}://playlist/LM`,
        kind: "playlist",
        name: "Liked Music",
      }),
      expect.objectContaining({ uri: `${PROVIDER}://playlist/PLwarped`, kind: "playlist" }),
      expect.objectContaining({ uri: `${PROVIDER}://artist/UClana`, kind: "artist" }),
    ]);
    expect(rows[1]!.items[0]).toEqual({
      uri: `${PROVIDER}://track/aaaaaaaaaa1`,
      kind: "track",
      name: "Time To Time",
      by: "James Blunt",
      image: "https://i.ytimg.com/vi/aaaaaaaaaa1/hq.jpg",
    });
    // As the brand channel, and only to YouTube Music.
    expect(yt.seen[0]!.path).toBe("/youtubei/v1/browse");
    expect(yt.seen[0]!.body).toMatchObject({
      browseId: "FEmusic_home",
      context: { user: { onBehalfOfUser: "107382491788380048492" } },
    });
  });

  it("says when YouTube Music refuses the sign-in", async () => {
    const refusing: Fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    await expect(youtubeChannels(refusing, COOKIE)).rejects.toThrow(YoutubeSignedOut);
  });
});
