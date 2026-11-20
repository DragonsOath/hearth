import { describe, expect, it } from "vitest";
import { DEFAULT_MEDIA_ANNOUNCE } from "./media";
import {
  channelIdFrom,
  channelName,
  linkChannels,
  movieNightInvitation,
  joinTokens,
  SUGGESTED_PLACES,
  type MovieNight,
} from "./movie-nights";

describe("Discord channel links", () => {
  it("reads the channel id from a link, a mention or the bare id", () => {
    expect(
      channelIdFrom("https://discord.com/channels/111111111111111111/1565080201413795884"),
    ).toBe("1565080201413795884");
    expect(channelIdFrom(" <#1565080201413795884> ")).toBe("1565080201413795884");
    expect(channelIdFrom("1565080201413795884")).toBe("1565080201413795884");
    expect(channelIdFrom("movie-chat")).toBeUndefined();
    expect(channelIdFrom("https://example.com/channels/1/2")).toBeUndefined();
  });

  it("names channels the way Discord does", () => {
    expect(channelName("#Movie Chat")).toBe("movie-chat");
  });

  it("turns #name into a channel link, only for whole saved names", () => {
    const links = [{ name: "movie-chat", id: "1565080201413795884" }];
    expect(linkChannels("go to #movie-chat to chat!", links)).toBe(
      "go to <#1565080201413795884> to chat!",
    );
    expect(linkChannels("#Movie-Chat", links)).toBe("<#1565080201413795884>");
    // A longer name, or one already a mention, is left alone.
    expect(linkChannels("#movie-chat-2 and <#1>", links)).toBe("#movie-chat-2 and <#1>");
  });
});

describe("the invitation's style", () => {
  const night: MovieNight = {
    id: "n1",
    key: "movie:tmdb:1",
    title: "Quiet Harbor",
    startsAt: "2026-11-07T04:00:00Z",
    timeZone: "America/Los_Angeles",
    spots: null,
    note: "",
    status: "scheduled",
    reminders: [],
    channels: [],
    guests: [],
    posts: [],
    remindersSent: [],
    createdAt: "2026-10-30T12:00:00Z",
  };
  const item = {
    kind: "movie" as const,
    title: "Quiet Harbor",
    year: 2026,
    overview: "x".repeat(400),
  };
  const pics = { poster: "poster.jpg", backdrop: "backdrop.jpg" };
  const embed = (look?: MovieNight["look"], images: typeof pics | { poster: string } = pics) =>
    movieNightInvitation(
      { ...night, ...(look ? { look } : {}) },
      item,
      DEFAULT_MEDIA_ANNOUNCE,
      images,
    ).embeds[0]!;

  it("Cinematic (the default): the poster beside the details", () => {
    expect(embed().thumbnail?.url).toBe("attachment://poster.jpg");
    expect(embed().image).toBeUndefined();
  });

  it("Streaming: the wide picture under the invitation, or the poster when there is none", () => {
    expect(embed("streaming").image?.url).toBe("attachment://backdrop.jpg");
    expect(embed("streaming").thumbnail).toBeUndefined();
    expect(embed("streaming", { poster: "poster.jpg" }).image?.url).toBe("attachment://poster.jpg");
  });

  it("Banner: the card has no title or picture of its own (the banner above has them)", () => {
    const e = movieNightInvitation({ ...night, look: "banner" }, item, DEFAULT_MEDIA_ANNOUNCE, {
      banner: "banner.png",
    }).embeds[0]!;
    expect(e.title).toBeUndefined();
    expect(e.image).toBeUndefined();
    expect(e.thumbnail).toBeUndefined();
    expect(e.description).not.toContain("xxxx");
    // No banner could be made: it reads as Streaming.
    expect(embed("banner").image?.url).toBe("attachment://backdrop.jpg");
    expect(embed("banner").title).toContain("Quiet Harbor");
  });

  it("Compact: the poster beside a shorter story line", () => {
    expect(embed("compact").thumbnail?.url).toBe("attachment://poster.jpg");
    expect(embed("compact").description!.length).toBeLessThan(embed().description!.length);
  });
});

describe("Watch on Plex keeps the real link", () => {
  it("turns {plex} into the movie's Plex link, or the name when none was found", () => {
    const join = [{ server: "plex" as const, name: "Plex", url: "https://app.plex.tv/x" }];
    expect(joinTokens("{plex} and press play.", join)).toBe(
      "[Open it in Plex](https://app.plex.tv/x) and press play.",
    );
    expect(joinTokens("{plex}", join, true)).toBe("Open it in Plex: https://app.plex.tv/x");
    expect(joinTokens("{jellyfin} now", join)).toBe("Open it in Jellyfin now");
    expect(SUGGESTED_PLACES[0]!.name).toBe("Watch on Plex");
  });
});
