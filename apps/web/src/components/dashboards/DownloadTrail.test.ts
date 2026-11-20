import { describe, expect, it } from "vitest";
import { trailQuestion } from "./DownloadTrail";

describe("Ask about a download", () => {
  it("sends the whole trail: what went wrong, the release, the app's reason and the file", () => {
    const q = trailQuestion("Chaptarr", {
      key: "1",
      title: "Zogarth - The Primal Hunter",
      release: "The Primal Hunter 1 - 100",
      status: "stuck",
      steps: [
        { kind: "grabbed", text: "Chaptarr grabbed it" },
        {
          kind: "stuck",
          text: "Downloaded, but Chaptarr has not imported it: Rejected: matched Tome 6",
          to: "/audiobooks-temp/The Primal Hunter 1-100.m4b",
        },
      ],
    } as never);
    expect(q).toContain('Chaptarr downloaded "Zogarth - The Primal Hunter" but did not import it.');
    expect(q).toContain("Release: The Primal Hunter 1 - 100.");
    expect(q).toContain("Chaptarr says: Downloaded, but Chaptarr has not imported it");
    expect(q).toContain("File: /audiobooks-temp/The Primal Hunter 1-100.m4b");
    expect(q).toContain("propose a plan");
  });
});
