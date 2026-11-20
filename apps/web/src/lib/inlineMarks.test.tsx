import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { inlineMarks } from "./inlineMarks";

const html = (text: string) => renderToStaticMarkup(<>{inlineMarks(text)}</>);

describe("inline marks in AI answers", () => {
  it("shows **bold** and `code` as such, not as asterisks and backticks", () => {
    expect(html("- **Clear the 7 failed jobs.** Only `photos_db` changes.")).toBe(
      '- <strong class="font-semibold">Clear the 7 failed jobs.</strong> Only <code class="rounded bg-raised px-1 text-[0.88em]">photos_db</code> changes.',
    );
  });

  it("keeps everything else plain text, so nothing becomes markup", () => {
    expect(html("<b>hi</b> 2 * 3 * 4")).toBe("&lt;b&gt;hi&lt;/b&gt; 2 * 3 * 4");
    expect(html("**not closed")).toBe("**not closed");
  });
});
