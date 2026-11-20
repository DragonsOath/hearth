import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// How requests work (11-10): the labels every request ends with live in .github/labels.json, and
// the Labels workflow makes them on the repository. Checked here so a template never names a
// label the repository won't have.
describe("the repository's labels (How requests work)", () => {
  const root = new URL("../../../", import.meta.url);
  const read = (p: string) => readFileSync(new URL(p, root), "utf8");
  const labels = JSON.parse(read(".github/labels.json")) as {
    name: string;
    color: string;
    description: string;
  }[];

  it("has the four outcomes and Duplicate, each with a colour and a short description", () => {
    for (const name of ["Planned", "PR welcome", "Ember can do this", "Not planned", "Duplicate"])
      expect(labels.map((l) => l.name)).toContain(name);
    for (const l of labels) {
      expect(l.color, l.name).toMatch(/^[0-9a-f]{6}$/);
      // GitHub refuses a label description over 100 characters.
      expect(l.description.length, l.name).toBeLessThanOrEqual(100);
      expect(l.description, l.name).not.toContain("\u2014");
    }
    expect(new Set(labels.map((l) => l.name.toLowerCase())).size).toBe(labels.length);
  });

  it("includes every label a template puts on a request or an issue", () => {
    for (const file of [
      ".github/DISCUSSION_TEMPLATE/panel-requests.yml",
      ".github/ISSUE_TEMPLATE/bug_report.yml",
      ".github/ISSUE_TEMPLATE/feature_request.yml",
    ]) {
      const m = /^labels:\s*\[(.*)\]/m.exec(read(file));
      expect(m, file).toBeTruthy();
      for (const name of m![1]!.split(",").map((s) => s.trim().replace(/^"|"$/g, "")))
        expect(
          labels.map((l) => l.name),
          `${file}: ${name}`,
        ).toContain(name);
    }
  });
});
