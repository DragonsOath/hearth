import { describe, expect, it } from "vitest";
import { cleanMeta, md, newer, previewBase, type EmberTask } from "./engine";

const task = (p: Partial<EmberTask>): EmberTask => ({
  id: 1,
  title: "t",
  state: "queued",
  project: "sandbox",
  engine: "claude-code",
  position: 0,
  prompt: "p",
  attempts: 0,
  max_attempts: 2,
  created_at: "2026-10-22T00:00:00",
  updated_at: "2026-10-22T00:00:00",
  ...p,
});

describe("War Room reply formatting", () => {
  it("escapes everything before adding its own few tags", () => {
    const html = md('<img src=x onerror="alert(1)"> **bold** `code`');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
  });

  it("only links web addresses, never scripts", () => {
    expect(md("[ok](https://example.com)")).toContain('href="https://example.com"');
    expect(md("[bad](javascript:alert(1))")).not.toContain("href=");
  });

  it("draws tables instead of printing their pipes", () => {
    const html = md(
      "Memory:\n\n| Part | Memory |\n|---|---|\n| Voice | **1.7 GB** |\n| Window | 2.1 GB |\n\nDone.",
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<th>Part</th><th>Memory</th>");
    expect(html).toContain("<td>Voice</td><td><strong>1.7 GB</strong></td>");
    expect(html).toContain("<td>Window</td><td>2.1 GB</td>");
    expect(html).not.toContain("|---|");
    expect(html).toContain("<p>Done.</p>");
    // A lone pipe in a sentence is just text.
    expect(md("a | b")).toBe("<p>a | b</p>");
  });

  it("draws lists, headings and code blocks", () => {
    const html = md("# Title\n- one\n- two\n\n```\n<b>raw</b>\n```");
    expect(html).toContain("<h4>Title</h4>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<pre><code>&lt;b&gt;raw&lt;/b&gt;\n</code></pre>");
  });

  it("shows only who answered", () => {
    expect(cleanMeta("Claude Code · sonnet")).toBe("Claude Code · sonnet");
    expect(cleanMeta("quick · routing reason")).toBe("");
  });
});

describe("War Room task updates", () => {
  it("never lets an older copy of a task replace a newer one", () => {
    const running = task({ state: "running", updated_at: "2026-10-22T00:00:05" });
    const queued = task({ state: "queued", updated_at: "2026-10-22T00:00:05" });
    expect(newer(queued, running)).toBe(false);
    expect(newer(running, queued)).toBe(true);
    expect(newer(task({ updated_at: "2026-10-22T00:00:09" }), running)).toBe(true);
    expect(newer(running)).toBe(true);
  });

  it("uses the engine's preview address as given", () => {
    expect(previewBase("/engine-preview/abc123/")).toBe("/engine-preview/abc123/");
  });
});
