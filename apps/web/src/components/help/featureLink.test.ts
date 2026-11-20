import { describe, expect, it } from "vitest";
import { md } from "../ember/engine";
import { HEARTH_LINK, featureLink } from "./featureLink";

// "Open it for me" (checklist 42.2): only Hearth's own pages and panels come out, and only for
// features that exist, are available, and (for an app's panel) whose app this installation has.

const panelHref = (ref?: string, tab?: string) =>
  ref ? `/?panels=${encodeURIComponent(tab ? `${ref}@${tab}` : ref)}` : undefined;
const services = [
  { id: "s1", name: "Plex", image: "plexinc/pms-docker" },
  { id: "s2", name: "Home Assistant", image: "ghcr.io/home-assistant/home-assistant" },
];

describe("where a feature opens", () => {
  it("goes to a page and its section", () => {
    expect(featureLink("media-announcements", services, panelHref)?.href).toBe(
      "/notifications#media-announcements",
    );
  });

  it("opens Movie nights in its own panel", () => {
    expect(featureLink("movie-nights", services, panelHref)?.href).toBe(
      `/?panels=${encodeURIComponent("tool:movie-nights")}`,
    );
    expect(featureLink("movie-nights", services, panelHref)?.label).toBe("Open Movie nights");
  });

  it("opens the Storage panel on the right tab", () => {
    expect(featureLink("raid", services, panelHref)?.href).toBe(
      `/?panels=${encodeURIComponent("tool:storage@volumes")}`,
    );
  });

  it("opens the panel of the app this installation has, and nothing when it has none", () => {
    const ha = featureLink("home-assistant", services, panelHref);
    expect(ha?.href).toBe(`/?panels=${encodeURIComponent("service:s2")}`);
    expect(ha?.label).toBe("Open Home Assistant");
    expect(featureLink("wizarr", services, panelHref)).toBeUndefined();
  });

  it("gives nothing for unknown or unbuilt features", () => {
    expect(featureLink("not-a-feature", services, panelHref)).toBeUndefined();
    expect(featureLink("build-homelab", services, panelHref)).toBeUndefined();
  });
});

describe("the AI's links in an answer", () => {
  it("matches only [words](hearth:feature)", () => {
    const text =
      "See [Open Movie nights](hearth:movie-nights), [a site](https://example.com) and [x](/vault).";
    expect([...text.matchAll(HEARTH_LINK)].map((m) => m[2])).toEqual(["movie-nights"]);
  });

  it("War Room: become new-tab links to Hearth, escaped, or plain words when unknown", () => {
    const open = (id: string) => featureLink(id, services, panelHref)?.href;
    const html = md("Go to [Open Movie nights](hearth:movie-nights).", open);
    expect(html).toContain(`href="/?panels=${encodeURIComponent("tool:movie-nights")}"`);
    expect(html).toContain('target="_blank"');
    expect(md("[Open it](hearth:not-a-feature)", open)).not.toContain("<a");
    expect(md("[Open it](hearth:not-a-feature)", open)).toContain("Open it");
    // Without a resolver (other places that show markdown), the words stay and the link goes.
    expect(md("[Open Movie nights](hearth:movie-nights)")).toBe("<p>Open Movie nights</p>");
    // The words are escaped like everything else.
    expect(md("[<b>x</b>](hearth:movie-nights)", open)).not.toContain("<b>");
  });
});
