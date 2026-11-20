import { describe, expect, it } from "vitest";
import { changeable, correct } from "./writing";

const fix = (text: string, opts: Parameters<typeof correct>[1] = {}) =>
  correct(text, { includeLast: true, ...opts }).text;

describe("basic writing assistance", () => {
  it("capitalizes sentences and a lone i, fixes known typos, tidies punctuation", () => {
    expect(fix("i think teh server is fine. can you check  it ?")).toBe(
      "I think the server is fine. Can you check it?",
    );
    expect(fix("why dont we restart it")).toBe("Why don't we restart it");
    expect(fix("Teh container stoped again")).toBe("The container stopped again");
    expect(fix("first line\nsecond line")).toBe("First line\nSecond line");
    // "e.g." looks technical (letters joined by dots), so it is left exactly as typed.
    expect(fix("e.g. this stays lower case")).toBe("e.g. this stays lower case");
  });

  it("leaves technical text alone", () => {
    const keep = [
      "docker restart plex",
      "check https://home.example.com/teh please",
      "look at /srv/homelab/docker/config/teh",
      "run `systemctl restart teh` now",
      "```\nteh code\n```",
      "use --dont-restart and $HOME",
      "the home.example.com route",
      "the qBittorrent and SABnzbd apps",
      "alex@homeserver is the user",
      "see #12 on the list",
    ];
    for (const text of keep) {
      const out = fix(text);
      expect(out.replace(/^./, (c) => c.toLowerCase())).toBe(
        text.replace(/^./, (c) => c.toLowerCase()),
      );
    }
    // Service names from the workspace are never touched, even at a sentence start.
    expect(fix("prowlarr is down", { vocabulary: ["Prowlarr"] })).toBe("prowlarr is down");
  });

  it("does not touch the word being typed, or anything after the caret", () => {
    const text = "i think teh";
    expect(correct(text, { upTo: text.length }).text).toBe("I think teh");
    const mid = "i said teh thing";
    const r = correct(mid, { upTo: 6, includeLast: true });
    expect(r.text).toBe("I said teh thing");
    expect(r.delta).toBe(0);
  });

  it("reports changes and respects undone words", () => {
    const r = correct("teh i", { includeLast: true });
    expect(r.changes).toEqual([
      { from: "teh", to: "the" },
      { from: "the", to: "The" },
      { from: "i", to: "I" },
    ]);
    expect(correct("teh plan", { includeLast: true, ignore: new Set(["teh"]) }).text).toBe(
      "teh plan",
    );
    expect(
      correct("lowercase start", { includeLast: true, ignore: new Set(["lowercase"]) }).text,
    ).toBe("lowercase start");
  });

  it("is a no-op on already clean text", () => {
    const r = correct("All good here. Nothing to fix.", { includeLast: true });
    expect(r).toMatchObject({ delta: 0, changes: [] });
  });
});

describe("changeable (Enhanced grammar suggestions)", () => {
  const text = "Restart radarr and and check /srv/homelab, `docker ps` or https://x.io now";
  const at = (s: string) => [text.indexOf(s), text.indexOf(s) + s.length] as const;
  it("allows ordinary words", () => {
    expect(changeable(text, ...at("and and"), ["radarr"])).toBe(true);
  });
  it("never suggests changes to paths, code, URLs, or your systems' names", () => {
    expect(changeable(text, ...at("storage"), ["radarr"])).toBe(false);
    expect(changeable(text, ...at("docker"), ["radarr"])).toBe(false);
    expect(changeable(text, ...at("x.io"), ["radarr"])).toBe(false);
    expect(changeable(text, ...at("radarr"), ["radarr"])).toBe(false);
    expect(changeable("ping host1 now", 5, 10)).toBe(false);
  });
});
