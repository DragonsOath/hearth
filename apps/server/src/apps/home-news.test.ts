import { describe, expect, it } from "vitest";
import type { Fetch } from "./http";
import { parseFeed, plain, readNews } from "./home-news";

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Town News</title>
<item><title><![CDATA[Bridge <b>reopens</b> &amp; traffic eases]]></title><link>https://news.example/bridge</link>
<pubDate>Thu, 05 Nov 2026 08:00:00 GMT</pubDate></item>
<item><title>Library hours change</title><link>javascript:alert(1)</link></item>
</channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Sports Desk</title>
<entry><title>Harbor City wins</title><link rel="alternate" href="https://sports.example/win"/>
<updated>2026-11-05T10:00:00Z</updated></entry></feed>`;

const feeds = (pages: Record<string, string>): Fetch =>
  (async (url: string) => {
    const body = pages[url];
    return {
      ok: Boolean(body),
      status: body ? 200 : 404,
      json: async () => ({}),
      text: async () => body ?? "",
    };
  }) as unknown as Fetch;

describe("the news widget", () => {
  it("reads RSS and Atom as plain headlines, with safe links only", () => {
    expect(plain("<![CDATA[A <i>b</i> &amp; &#39;c&#39;]]>")).toBe("A b & 'c'");
    const rss = parseFeed(RSS, "x");
    expect(rss[0]).toEqual({
      title: "Bridge reopens & traffic eases",
      link: "https://news.example/bridge",
      source: "Town News",
      at: "2026-11-05T08:00:00.000Z",
    });
    expect(rss[1]!.link).toBeUndefined();
    expect(parseFeed(ATOM, "x")[0]).toMatchObject({
      title: "Harbor City wins",
      link: "https://sports.example/win",
      source: "Sports Desk",
    });
  });

  it("puts the newest first across feeds and says which feed could not be read", async () => {
    const r = await readNews(
      feeds({ "https://a.example/rss": RSS, "https://b.example/atom": ATOM }),
      [
        { url: "https://a.example/rss" },
        { url: "https://b.example/atom" },
        { url: "https://gone.example/rss", name: "Gone" },
      ],
      1,
    );
    expect(r.items.map((i) => i.title).slice(0, 2)).toEqual([
      "Harbor City wins",
      "Bridge reopens & traffic eases",
    ]);
    expect(r.problems).toEqual(["Gone: answered 404"]);
  });
});
