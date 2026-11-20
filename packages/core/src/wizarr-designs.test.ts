import { describe, expect, it } from "vitest";
import {
  WIZARR_DESIGNS,
  WIZARR_THEMES,
  buildDesignStep,
  escapeText,
  isDesignStep,
  restyleStep,
  stepTheme,
  stepWording,
  themeHtml,
} from "./wizarr-designs";

const vault = WIZARR_DESIGNS.find((d) => d.id === "vault")!;
const theme = (id: string) => WIZARR_THEMES.find((t) => t.id === id)!;

describe("Wizarr designs", () => {
  it("gives Jellyfin, Plex and Audiobookshelf their steps, Plex's sign-in first", () => {
    expect(Object.keys(vault.servers)).toEqual(["jellyfin", "plex", "audiobookshelf"]);
    for (const s of Object.values(vault.servers))
      for (const st of s.steps) expect(st.html).toContain('class="vault-shell"');
    expect(vault.servers.plex!.steps[0]).toMatchObject({
      category: "pre_invite",
      requireInteraction: true,
    });
  });

  it("keeps the design as it is in Original, and moves every color together in a theme", () => {
    const html = vault.servers.jellyfin!.steps[0]!.html;
    expect(themeHtml(html, "#aa5cc3", theme("original"))).toBe(html);
    const green = themeHtml(html, "#aa5cc3", theme("emerald"));
    expect(green).not.toContain("#aa5cc3");
    expect(green).not.toContain("rgba(170,92,195");
    // White and black stay; layout and Wizarr's fill-ins are untouched.
    expect(green.match(/#fff\b/g)?.length).toBe(html.match(/#fff\b/g)?.length);
    expect(green).toContain("{{ server_name }}");
    expect(green.replace(/#[0-9a-f]{3,6}\b|rgba?\([^)]*\)/gi, "")).toBe(
      html.replace(/#[0-9a-f]{3,6}\b|rgba?\([^)]*\)/gi, ""),
    );
  });

  it("reads each step's wording, and puts the owner's words in as plain text", () => {
    const st = vault.servers.jellyfin!.steps[0]!;
    expect(stepWording(st.html)).toEqual({
      eyebrow: "Account ready",
      headline: "Welcome to {{ server_name }}",
      intro: expect.stringMatching(/^Your Jellyfin account is active/),
    });
    const built = buildDesignStep(vault, "jellyfin", st.id, "ocean", {
      headline: "Welcome to the <b>family</b> server",
      intro: "",
    });
    expect(stepWording(built).headline).toBe("Welcome to the <b>family</b> server");
    expect(built).toContain("Welcome to the &lt;b&gt;family&lt;/b&gt; server");
    // An empty field keeps the design's own words.
    expect(stepWording(built).intro).toMatch(/^Your Jellyfin account is active/);
    expect(escapeText('a & "b"')).toBe("a &amp; &quot;b&quot;");
  });

  it("refuses a step the design does not have", () => {
    expect(() => buildDesignStep(vault, "emby", "x", "original")).toThrow(/no such step/);
  });

  // A saved step from an earlier copy of the design: its own title, words and layout (11-04).
  const saved = vault.servers
    .plex!.steps[1]!.html.replace(
      /<p class="vault-eyebrow">[\s\S]*?<\/p>/,
      '<span class="vault-who">Plex</span>',
    )
    .replace(/<h1>[\s\S]*?<\/h1>/, "<h1>You&#39;re in!</h1>")
    .concat('<p class="mine">House rule: no spoilers in the chat.</p>');
  const words = (h: string) =>
    h
      .replace(/\/\* hearth-colors[^*]*\*\/\n?/g, "")
      .replace(/#[0-9a-f]{3,6}\b|rgba?\([^)]*\)/gi, "");

  it("recolors a saved step without touching a word of it", () => {
    expect(isDesignStep(saved)).toBe(true);
    expect(stepTheme(saved)).toBe("original");
    const green = restyleStep(saved, "emerald");
    expect(stepTheme(green)).toBe("emerald");
    expect(words(green)).toBe(words(saved));
    expect(green).toContain("House rule: no spoilers in the chat.");
    expect(green).toContain("<h1>You&#39;re in!</h1>");
    expect(green.split(" */")[1]).not.toContain("#e5a00d");
    expect(stepWording(saved)).toEqual({
      eyebrow: "Plex",
      headline: "You're in!",
      intro: expect.any(String),
    });
  });

  it("changes colors again from the step's own colors, and Original puts them back exactly", () => {
    const once = restyleStep(saved, "rose");
    const twice = restyleStep(restyleStep(restyleStep(saved, "mono"), "emerald"), "rose");
    expect(twice).toBe(once);
    expect(restyleStep(twice, "original")).toBe(saved);
    // Leaving it in the same theme changes nothing.
    expect(restyleStep(once, "rose")).toBe(once);
  });

  it("rewrites only the wording the owner changed", () => {
    const w = stepWording(saved);
    const same = restyleStep(saved, "original", { ...w } as Record<string, string>);
    expect(same).toBe(saved);
    const changed = restyleStep(saved, "ocean", { headline: "Welcome, friend" });
    expect(stepWording(changed).headline).toBe("Welcome, friend");
    expect(stepWording(changed).eyebrow).toBe("Plex");
    expect(changed).toContain("House rule: no spoilers in the chat.");
  });
});
