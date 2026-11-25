import { describe, expect, it } from "vitest";
import { checkLine, isSensitive, LINE_POOL, pickLine } from "./ember-lines";
import {
  EMBER_LINES_MAX_PER_DAY,
  type AnnounceItem,
  type AnnounceKind,
  announceTitle,
  batchTitle,
  DEFAULT_MEDIA_ANNOUNCE,
  discordAnnouncement,
  discordDigest,
  groupForBatch,
  LIBRARY_KINDS,
  mediaAnnounceSettings,
  HERALD_ICON,
} from "./media";

// "New in your library" for everything a home server adds, not just movies and shows.

const on = mediaAnnounceSettings({
  types: Object.fromEntries(LIBRARY_KINDS.map((k) => [k, true])) as Record<AnnounceKind, boolean>,
});
const card = (i: AnnounceItem, line?: string) =>
  discordAnnouncement(
    i,
    on,
    { poster: "cover.jpg" },
    line ? { line: { text: line, aiName: "Ember" } } : {},
  ).embeds[0]!;

const album: AnnounceItem = {
  kind: "album",
  title: "Rumours",
  year: 1977,
  creators: ["Fleetwood Mac"],
  genres: ["Rock"],
  tracks: 11,
  runtimeMin: 39,
};
const audiobook: AnnounceItem = {
  kind: "audiobook",
  title: "Leviathan Wakes",
  creators: ["James S. A. Corey"],
  narrators: ["Jefferson Mays"],
  seriesName: "The Expanse",
  seriesIndex: 1,
  runtimeMin: 1210,
  genres: ["Science Fiction"],
};
const book: AnnounceItem = {
  kind: "book",
  title: "The Hobbit",
  creators: ["J. R. R. Tolkien"],
  pages: 310,
  genres: ["Fantasy"],
};
const comic: AnnounceItem = {
  kind: "comic",
  title: "Issue 12",
  seriesName: "Saga",
  seriesIndex: 12,
  pages: 32,
};
const game: AnnounceItem = {
  kind: "game",
  title: "Chrono Trigger",
  platform: "SNES",
  year: 1995,
  genres: ["RPG"],
};
const podcast: AnnounceItem = { kind: "podcast", title: "Episode 200", show: "Homelab Hour" };

describe("New in your library: every kind is off until the owner turns it on", () => {
  it("only movies, series and seasons are on by default", () => {
    for (const k of LIBRARY_KINDS) expect(DEFAULT_MEDIA_ANNOUNCE.types[k]).toBe(false);
    expect(DEFAULT_MEDIA_ANNOUNCE.types.movie).toBe(true);
    // Settings saved before these kinds existed get them, off.
    const old = mediaAnnounceSettings({ types: { movie: false } } as never);
    expect(old.types.album).toBe(false);
    expect(old.looks.album.heading).toBe("New music");
  });
});

describe("New in your library: a card for each kind", () => {
  it("music: album by artist with year, tracks and length", () => {
    const c = card(album);
    expect(c.title).toBe("Rumours by Fleetwood Mac (1977)");
    expect(c.author?.name).toBe("New music");
    expect(c.description).toContain("11 tracks");
    expect(c.description).toContain("39m");
    expect(c.thumbnail).toEqual({ url: "attachment://cover.jpg" });
  });

  it("audiobooks: author, narrator, series and length", () => {
    const c = card(audiobook);
    expect(c.title).toBe("Leviathan Wakes by James S. A. Corey");
    expect(c.description).toContain("Read by Jefferson Mays");
    expect(c.description).toContain("The Expanse #1");
    expect(c.description).toContain("20h 10m");
  });

  it("ebooks: author and pages", () => {
    const c = card(book);
    expect(c.title).toBe("The Hobbit by J. R. R. Tolkien");
    expect(c.description).toContain("310 pages");
  });

  it("comics: the series and issue number", () => {
    expect(card(comic).title).toBe("Saga #12");
    expect(
      announceTitle({ kind: "comic", title: "Saga #12", seriesName: "Saga", seriesIndex: 12 }),
    ).toBe("Saga #12");
  });

  it("games: the system it plays on, and its year", () => {
    const c = card(game);
    expect(c.title).toBe("Chrono Trigger (SNES)");
    expect(c.description).toContain("1995");
  });

  it("podcasts: the show and the episode", () => {
    expect(card(podcast).title).toBe("Homelab Hour: Episode 200");
  });

  it("Ember's line leads the card, under the name she goes by", () => {
    const c = discordAnnouncement(
      album,
      on,
      {},
      { line: { text: "Fresh tracks.", aiName: "Cinder" } },
    ).embeds[0]!;
    // Messenger Ember beside her line, at the top of the card; the heading joins the title.
    expect(c.author).toEqual({ name: "Cinder: Fresh tracks.", icon_url: HERALD_ICON });
    expect(c.title).toMatch(/^New music: /);
    expect(c.description ?? "").not.toContain("Cinder:");
  });
});

describe("New in your library: bursts go out as one message", () => {
  it("several albums become one batch; a lone game stays its own card", () => {
    const albums = [album, { ...album, title: "Tusk" }, { ...album, title: "Mirage" }];
    const out = groupForBatch([albums[0]!, game, albums[1]!, albums[2]!]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ batch: "album", items: albums });
    expect(out[1]).toEqual({ item: game });
  });

  it("a single album is a normal card, not a batch of one", () => {
    expect(groupForBatch([album])).toEqual([{ item: album }]);
  });

  it("the batch message says how many, with its line", () => {
    const albums = Array.from({ length: 6 }, (_, i) => ({ ...album, title: `Album ${i + 1}` }));
    const post = discordDigest(albums, on, {
      batch: "album",
      line: { text: "A fresh crate of records. Dig in.", aiName: "Ember" },
    });
    const e = post.embeds[0]!;
    expect(e.title).toBe("6 new albums");
    expect(e.author).toEqual({
      name: "Ember: A fresh crate of records. Dig in.",
      icon_url: HERALD_ICON,
    });
    expect(e.description).toContain("Album 6 by Fleetwood Mac");
    expect(batchTitle("podcast", 1)).toBe("1 new podcast episode");
    expect(batchTitle("series", 2)).toBe("2 new series");
  });
});

describe("Ember's one-liner", () => {
  const fixed = (n: number) => () => n;

  it("fits the item: a genre or decade line before a general one", () => {
    const horror: AnnounceItem = {
      kind: "movie",
      title: "Night of the Living Dead",
      genres: ["Horror"],
      year: 2005,
    };
    const l = pickLine({ item: horror }, "playful", { rand: fixed(0.9) });
    expect(l?.id.startsWith("horror-")).toBe(true);
    const eighties: AnnounceItem = { kind: "movie", title: "Back to the Future", year: 1985 };
    expect(pickLine({ item: eighties }, "playful", { rand: fixed(0.9) })?.id).toBe("decade-80s");
  });

  it("never repeats the last line back to back", () => {
    let last: string | undefined;
    for (let i = 0; i < 50; i++) {
      const l = pickLine({ item: game }, "playful", { last, rand: Math.random })!;
      expect(l.id).not.toBe(last);
      last = l.id;
    }
  });

  it("gentle uses gentle lines; off has none", () => {
    const l = pickLine({ item: book }, "gentle", { rand: fixed(0) })!;
    expect(LINE_POOL.find((p) => p.id === l.id)?.tone).toBe("gentle");
    expect(pickLine({ item: book }, "off")).toBeUndefined();
  });

  it("health, religion, sexuality, self-help and children's content only get plain lines", () => {
    const sensitive: AnnounceItem[] = [
      { kind: "book", title: "Healing Your Gut", genres: ["Health & Fitness"] },
      { kind: "audiobook", title: "Confessions", genres: ["Religion"] },
      { kind: "book", title: "Atomic Habits", genres: ["Self-Help"] },
      { kind: "movie", title: "Paddington", genres: ["Family", "Comedy"] },
      { kind: "album", title: "Lullabies", genres: ["Children's Music"] },
      { kind: "book", title: "Queer Eye for Everyone", genres: ["LGBTQ+"] },
    ];
    for (const item of sensitive) {
      expect(isSensitive(item)).toBe(true);
      for (let i = 0; i < 20; i++) {
        const l = pickLine({ item }, "playful")!;
        const line = LINE_POOL.find((p) => p.id === l.id)!;
        expect(line.tone).toBe("gentle");
        expect(line.genre).toBeUndefined();
      }
    }
    // One sensitive title in a batch keeps the whole batch plain.
    const b = pickLine({ batch: "book", items: [book, sensitive[2]!] }, "playful")!;
    expect(LINE_POOL.find((p) => p.id === b.id)?.tone).toBe("gentle");
  });

  it("every written line keeps the house rules", () => {
    for (const l of LINE_POOL) {
      // No long dashes, no names, nothing mocking, nothing about sensitive subjects.
      expect(checkLine(l.text), l.id).toBe(l.text);
      expect(l.text.length).toBeLessThanOrEqual(80);
    }
    expect(new Set(LINE_POOL.map((l) => l.id)).size).toBe(LINE_POOL.length);
    // Every kind has playful and gentle lines, for single items and for batches.
    for (const k of [...LIBRARY_KINDS, "movie", "series", "season", "episode"] as AnnounceKind[]) {
      for (const tone of ["playful", "gentle"] as const) {
        expect(pickLine({ item: { kind: k, title: "X" } }, tone), `${k} ${tone}`).toBeDefined();
        expect(pickLine({ batch: k, items: [] }, tone), `${k} batch ${tone}`).toBeDefined();
      }
    }
  });

  it("a line Ember writes is checked: never the requester's name, never mocking", () => {
    expect(checkLine("Sam asked for this one, enjoy!", ["Sam"])).toBeUndefined();
    expect(checkLine("A guilty pleasure if ever there was one.")).toBeUndefined();
    expect(checkLine("Great for your mental health.")).toBeUndefined();
    expect(checkLine("See https://example.com")).toBeUndefined();
    expect(checkLine("x".repeat(141))).toBeUndefined();
    expect(checkLine('"A classic, freshly shelved — enjoy"')).toBe(
      "A classic, freshly shelved, enjoy.",
    );
  });
});

describe("Let Ember write it: the daily cap", () => {
  it("is 10 by default and never more than 50, whatever was saved", () => {
    expect(DEFAULT_MEDIA_ANNOUNCE.emberWrites).toBe(false);
    expect(mediaAnnounceSettings(null).emberWritesPerDay).toBe(10);
    expect(mediaAnnounceSettings({ emberWritesPerDay: 5000 }).emberWritesPerDay).toBe(
      EMBER_LINES_MAX_PER_DAY,
    );
    expect(mediaAnnounceSettings({ emberWritesPerDay: -3 }).emberWritesPerDay).toBe(0);
  });
});

describe("the title line", () => {
  it("never shows the year twice when the title already ends with it", () => {
    const show = { kind: "series", title: "Dig (2026)", year: 2026 } as AnnounceItem;
    expect(announceTitle(show)).toBe("Dig (2026)");
    expect(announceTitle({ ...show, title: "Dig" })).toBe("Dig (2026)");
  });
});
