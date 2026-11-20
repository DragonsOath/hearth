import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APP_INTEGRATIONS,
  FEATURES,
  featureOpen,
  manualSection,
  manualTags,
} from "@dragon-control/core";

/**
 * Keeps the feature list (packages/core/src/features.ts) honest against the code (checklist
 * 42.1): every page it names is a real route, every on-screen name is in the interface, every
 * test it cites exists, every AI tool it names is registered, and the manual covers it. Checks
 * are on what the list claims exactly (labels), never on the manual's descriptive wording.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(tsx?|ts)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}

/** The interface's text, with JSX line breaks and entities flattened. */
const webText = sources(path.join(root, "apps", "web", "src"))
  .map((p) => readFileSync(p, "utf8"))
  .join("\n")
  .replace(/&apos;|&#39;|&rsquo;|’/g, "'")
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ");

const manual = read("docs/HEARTH_MANUAL.md");

describe("the feature list matches the code", () => {
  it("names only real pages, and Settings tabs that exist", () => {
    const main = read("apps/web/src/main.tsx");
    const routes = new Set(["", ...[...main.matchAll(/path: "([^"]+)"/g)].map((m) => m[1]!)]);
    const settings = read("apps/web/src/pages/Settings.tsx");
    const tabs = /const TABS = \[([^\]]+)\]/.exec(settings)![1]!;
    const sections = /const SECTION_TABS[^=]*= \{([^}]+)\}/.exec(settings)![1]!;
    const anchors = new Set([
      ...[...tabs.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!),
      ...[...sections.matchAll(/"?([a-z-]+)"?:/g)].map((m) => m[1]!),
    ]);
    for (const f of FEATURES) {
      const route = f.where.route;
      if (!route) continue;
      const [page, hash] = route.slice(1).split("#");
      expect(routes.has(page!), `${f.id}: ${route} is not a page`).toBe(true);
      if (hash) {
        expect(page, f.id).toBe("settings");
        expect(anchors.has(hash), `${f.id}: no Settings tab or section #${hash}`).toBe(true);
      }
    }
  });

  it("opens only real pages, sections, Storage tabs and apps (Open it for me, 42.2)", () => {
    const main = read("apps/web/src/main.tsx");
    const routes = new Set(["", ...[...main.matchAll(/path: "([^"]+)"/g)].map((m) => m[1]!)]);
    const storage = read("apps/web/src/components/storage/StorageCenterPanel.tsx");
    const storageTabs = new Set(
      [...storage.matchAll(/\{ id: "([a-z]+)", label:/g)].map((m) => m[1]!),
    );
    const wrong: string[] = [];
    for (const f of FEATURES) {
      const o = featureOpen(f);
      if (!o) continue;
      if ("page" in o) {
        const [page, hash] = o.page.slice(1).split("#");
        if (!o.page.startsWith("/") || !routes.has(page!))
          wrong.push(`${f.id}: ${o.page} is not a page`);
        // A section of a page other than Settings: an element with that id in the interface.
        if (hash && page !== "settings" && !webText.includes(`id="${hash}"`))
          wrong.push(`${f.id}: nothing has id="${hash}"`);
      } else if ("panel" in o) {
        if (o.tab && !storageTabs.has(o.tab)) wrong.push(`${f.id}: Storage has no tab ${o.tab}`);
      } else {
        for (const a of o.app) if (!(a in APP_INTEGRATIONS)) wrong.push(`${f.id}: no app ${a}`);
      }
    }
    expect(storageTabs.size).toBeGreaterThan(5);
    expect(wrong).toEqual([]);
  });

  it("uses on-screen names that are in the interface", () => {
    const missing = FEATURES.flatMap((f) =>
      f.labels.filter((l) => !webText.includes(l)).map((l) => `${f.id}: "${l}"`),
    );
    expect(missing).toEqual([]);
  });

  it("cites tests that exist, by their exact titles", () => {
    const missing = FEATURES.flatMap((f) =>
      f.evidence
        .filter((e) => {
          const file = path.join(root, e.file);
          if (!existsSync(file)) return true;
          const src = readFileSync(file, "utf8");
          return !['"', "'", "`"].some((q) => src.includes(`${q}${e.test}${q}`));
        })
        .map((e) => `${f.id}: ${e.file} "${e.test}"`),
    );
    expect(missing).toEqual([]);
  });

  it("names only AI tools Hearth registers", () => {
    const tools = read("apps/server/src/agent/tools.ts");
    const registered = new Set(
      [...tools.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]!),
    );
    expect(registered.has("hearth_help")).toBe(true);
    const unknown = FEATURES.flatMap((f) =>
      [f.ember?.prepare, f.ember?.execute]
        .flatMap((a) => a?.tools ?? [])
        .filter((t) => !registered.has(t))
        .map((t) => `${f.id}: ${t}`),
    );
    expect(unknown).toEqual([]);
  });
});

describe("the manual covers the feature list", () => {
  it("tags only registered features, and every built feature has a section", () => {
    const ids = new Set(FEATURES.map((f) => f.id));
    expect(manualTags(manual).filter((id) => !ids.has(id))).toEqual([]);
    const uncovered = FEATURES.filter(
      (f) => f.status !== "planned" && !manualSection(manual, f.id)?.trim(),
    ).map((f) => f.id);
    expect(uncovered).toEqual([]);
  });

  it("gives each section the right part", () => {
    expect(manualSection(manual, "movie-nights")).toMatch(
      /^### Movie nights[\s\S]*Post the invitation/,
    );
    expect(manualSection(manual, "raid")).toMatch(/^- \*\*RAID \/ Arrays\*\*: every array/);
    // A list item inside a list item: only its own lines.
    const bot = manualSection(manual, "hearth-bot")!;
    expect(bot).toContain("Add Hearth to my server");
    expect(bot).not.toContain("your own bot");
    // Tagged in two places: both parts.
    expect(manualSection(manual, "updates")).toMatch(/Update now[\s\S]*Update Hearth/);
  });
});
