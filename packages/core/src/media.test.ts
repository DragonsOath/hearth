import { describe, expect, it } from "vitest";
import { DEFAULT_MEDIA_ANNOUNCE, discordAnnouncement, type AnnounceItem } from "./media";

const movie: AnnounceItem = {
  kind: "movie",
  title: "Night of the Living Dead",
  year: 1968,
  overview: "A group of strangers hide in a farmhouse.",
  genres: ["Horror"],
  runtimeMin: 96,
  trailer: "https://www.youtube.com/watch?v=abcdef1",
  availableIn: ["Plex"],
};
const banner = {
  ...DEFAULT_MEDIA_ANNOUNCE,
  looks: {
    ...DEFAULT_MEDIA_ANNOUNCE.looks,
    movie: { template: "banner" as const, heading: "Just added to the Vault" },
  },
};

describe("media announcements: the Banner style", () => {
  it("leads with Hearth's picture; the card keeps the story, trailer and footer", () => {
    const post = discordAnnouncement(movie, banner, {
      banner: "banner.png",
      poster: "poster.jpg",
      backdrop: "backdrop.jpg",
    });
    const card = post.embeds[0]!;
    // The picture above the card has the heading, title and details already.
    expect(card.author).toBeUndefined();
    expect(card.title).toBeUndefined();
    expect(card.description).not.toContain("Horror");
    expect(card.description).toContain("A group of strangers");
    expect(card.description).toContain("Watch trailer");
    expect(card.footer?.text).toContain("Available in Plex");
    // Not inside the card: Discord shows an attachment the card does not use above it.
    expect(card.image).toBeUndefined();
    expect(card.thumbnail).toBeUndefined();
  });

  it("falls back to the Streaming look when the picture could not be made", () => {
    const card = discordAnnouncement(movie, banner, {
      poster: "poster.jpg",
      backdrop: "backdrop.jpg",
    }).embeds[0]!;
    expect(card.title).toBe("Night of the Living Dead (1968)");
    expect(card.image).toEqual({ url: "attachment://backdrop.jpg" });
  });
});
