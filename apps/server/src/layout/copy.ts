import { randomUUID } from "node:crypto";
import type {
  LayoutCopyResult,
  LayoutPart,
  LayoutPreview,
  LayoutShare,
} from "@dragon-control/core";
import { LAYOUT_BROWSER_KEYS } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { deleteSetting, getSetting, setSetting } from "../store/settings";
import { recordAudit } from "../store/audit";

/**
 * Copying the layout of another Hearth (11-08: two separate Hearths, DV and the home server; "click a
 * button, copy the home server's layout, then everything is identical, and vice versa, but also keep each one
 * different if you want"). Each Hearth keeps its own layout until you copy: copying is one time,
 * and Undo puts the layout before it back.
 *
 * A layout is: the Lair's saved layouts, the order of its app strip and its conversation dock, the
 * home dashboard (its widgets, Home Assistant devices, clock, start page), the theme and the AI's
 * look style, and the sidebar (open or narrow). The browser parts live in the browser, so each
 * Hearth keeps a copy of the last one arranged there (PUT /api/layout/browser) for another Hearth
 * to read.
 *
 * Another Hearth reads it only with this Hearth's API key (the same key that links a PC), and only
 * the layout: names of apps and projects (to match them up), never anything else.
 */

type Json = Record<string, unknown>;

/** Which browser keys belong to which part. */
const PART_KEYS: Record<LayoutPart, string[]> = {
  lair: ["hearth-lair-order", "dc-desk-dock"],
  home: ["hearth.home-dashboard"],
  look: [],
  sidebar: ["dc-sidebar-rail"],
};

export class LayoutCopy {
  constructor(
    private readonly handle: DbHandle,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private get db() {
    return this.handle.db;
  }

  /** The browser's own layout, kept so another Hearth can read it. */
  async saveBrowser(values: Record<string, string>): Promise<void> {
    const clean: Record<string, string> = {};
    for (const k of LAYOUT_BROWSER_KEYS)
      if (typeof values[k] === "string" && values[k]!.length <= 20_000) clean[k] = values[k]!;
    await setSetting(this.db, "layout_browser", { values: clean, at: new Date().toISOString() });
  }

  /** This Hearth's layout, for another Hearth that has its key. */
  async share(): Promise<LayoutShare> {
    const desk = await this.db.select().from(t.deskLayouts);
    const services = await this.db
      .select({ id: t.services.id, name: t.services.name })
      .from(t.services);
    const projects = await this.db
      .select({ id: t.memoryProjects.id, name: t.memoryProjects.name })
      .from(t.memoryProjects);
    const browser = await getSetting(this.db, "layout_browser");
    return {
      name: (await getSetting(this.db, "instance_name")) ?? "Hearth",
      ...(browser?.at ? { browserAt: browser.at } : {}),
      theme: (await getSetting(this.db, "ui_theme")) ?? null,
      lookStyle: (await getSetting(this.db, "ai_look_style")) ?? null,
      deskLayouts: desk.map((d) => ({ name: d.name, panels: d.panels, dock: d.dock ?? null })),
      browser: browser?.values ?? {},
      services,
      projects,
    };
  }

  /** Asks the other Hearth for its layout with its key (server to server: nothing in the page). */
  private async fetchShare(hubUrl: string, key: string): Promise<LayoutShare> {
    let hub = hubUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(hub)) hub = `http://${hub}${/:\d+$/.test(hub) ? "" : ":7600"}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${hub}/api/layout/share`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: key.trim() }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new LayoutError(
        `This Hearth can't reach a Hearth at ${hub}. Check the address, and that both are on the same network (or Tailscale).`,
      );
    }
    const body = (await res.json().catch(() => ({}))) as LayoutShare & { message?: string };
    if (!res.ok)
      throw new LayoutError(
        res.status === 404
          ? "That Hearth is older and can't share its layout yet: update it first."
          : (body.message ?? `That Hearth said no (${res.status}).`),
      );
    return body;
  }

  /** What copying would do, changing nothing. */
  async preview(hubUrl: string, key: string, parts: LayoutPart[]): Promise<LayoutPreview> {
    const share = await this.fetchShare(hubUrl, key);
    const plan = await this.plan(share, parts);
    return {
      from: share.name,
      ...(share.browserAt ? { browserAt: share.browserAt } : {}),
      parts,
      deskLayouts: plan.deskLayouts.map((d) => d.name),
      missing: plan.missing,
      hasBrowser: Object.keys(share.browser ?? {}).length > 0,
    };
  }

  /** Copies the chosen parts here; returns the browser parts for the page to put in place. */
  async copy(hubUrl: string, key: string, parts: LayoutPart[]): Promise<LayoutCopyResult> {
    const share = await this.fetchShare(hubUrl, key);
    const plan = await this.plan(share, parts);
    // What it was, for Undo.
    const before = await this.share();
    await setSetting(this.db, "layout_before_copy", {
      at: new Date().toISOString(),
      parts,
      theme: before.theme,
      lookStyle: before.lookStyle,
      deskLayouts: before.deskLayouts,
      browser: before.browser,
    });
    await this.apply(parts, {
      theme: share.theme,
      lookStyle: share.lookStyle,
      deskLayouts: plan.deskLayouts,
    });
    await recordAudit(this.db, {
      actor: "you",
      action: `Copied the layout of ${share.name} (${parts.join(", ")})`,
      target: "layout",
    });
    return { from: share.name, parts, browser: plan.browser, missing: plan.missing, canUndo: true };
  }

  /** Puts the layout before the last copy back. */
  async undo(): Promise<LayoutCopyResult> {
    const before = await getSetting(this.db, "layout_before_copy");
    if (!before) throw new LayoutError("There is no copied layout to undo.");
    const parts = before.parts as LayoutPart[];
    await this.apply(parts, {
      theme: before.theme,
      lookStyle: before.lookStyle,
      deskLayouts: before.deskLayouts as LayoutShare["deskLayouts"],
    });
    const browser: Record<string, string | null> = {};
    for (const p of parts)
      for (const k of PART_KEYS[p])
        browser[k] = ((before.browser as Json)[k] as string | undefined) ?? null;
    await deleteSetting(this.db, "layout_before_copy");
    await recordAudit(this.db, {
      actor: "you",
      action: "Undid the copied layout",
      target: "layout",
    });
    return { from: "before the copy", parts, browser, missing: [], canUndo: false };
  }

  private async apply(
    parts: LayoutPart[],
    v: { theme: unknown; lookStyle: unknown; deskLayouts: LayoutShare["deskLayouts"] },
  ) {
    if (parts.includes("look")) {
      if (v.theme) await setSetting(this.db, "ui_theme", v.theme as never);
      if (v.lookStyle) await setSetting(this.db, "ai_look_style", v.lookStyle as never);
    }
    if (parts.includes("lair")) {
      // "Identical": the saved layouts become the other Hearth's, all of them.
      await this.db.delete(t.deskLayouts);
      const at = new Date().toISOString();
      for (const d of v.deskLayouts)
        await this.db.insert(t.deskLayouts).values({
          id: randomUUID(),
          name: d.name,
          panels: d.panels,
          dock: (d.dock as { width?: number; mode?: string } | null) ?? null,
          createdAt: at,
          updatedAt: at,
        });
    }
  }

  /** The other Hearth's layout in this Hearth's terms: its apps and projects matched by name. */
  private async plan(share: LayoutShare, parts: LayoutPart[]) {
    const localServices = await this.db
      .select({ id: t.services.id, name: t.services.name })
      .from(t.services);
    const localProjects = await this.db
      .select({ id: t.memoryProjects.id, name: t.memoryProjects.name })
      .from(t.memoryProjects);
    const byName = (rows: { id: string; name: string }[]) =>
      new Map(rows.map((r) => [r.name.trim().toLowerCase(), r.id]));
    const names = (rows: { id: string; name: string }[]) =>
      new Map(rows.map((r) => [r.id, r.name]));
    const remote = { service: names(share.services ?? []), project: names(share.projects ?? []) };
    const local = { service: byName(localServices), project: byName(localProjects) };
    const missing = new Set<string>();
    /** "service:<their id>" to "service:<our id>", or undefined when we don't have it. */
    const mapKey = (key: string): string | undefined => {
      const colon = key.indexOf(":");
      const kind = key.slice(0, colon);
      const id = key.slice(colon + 1);
      if (kind === "tool") return key;
      if (kind !== "service" && kind !== "project") return undefined;
      const name = remote[kind].get(id);
      const here = name ? local[kind].get(name.trim().toLowerCase()) : undefined;
      if (!here) {
        missing.add(name ?? key);
        return undefined;
      }
      return `${kind}:${here}`;
    };
    const mapPanels = (panels: string) =>
      panels
        .split(",")
        .filter(Boolean)
        .map((raw) => {
          const pinned = raw.startsWith("!");
          const body = pinned ? raw.slice(1) : raw;
          const [head, tab] = body.split("@");
          const decoded = decodeURIComponent(head ?? "");
          const mapped = mapKey(decoded);
          if (!mapped) return undefined;
          const [k, ...rest] = mapped.split(":");
          return `${pinned ? "!" : ""}${encodeURIComponent(k!)}:${encodeURIComponent(rest.join(":"))}${tab ? `@${tab}` : ""}`;
        })
        .filter((x): x is string => Boolean(x))
        .join(",");
    const deskLayouts = parts.includes("lair")
      ? (share.deskLayouts ?? []).map((d) => ({ ...d, panels: mapPanels(d.panels) }))
      : [];
    const browser: Record<string, string | null> = {};
    for (const p of parts)
      for (const k of PART_KEYS[p]) {
        const v = share.browser?.[k];
        if (typeof v !== "string") continue;
        if (k === "hearth-lair-order") {
          try {
            const order = JSON.parse(v) as unknown;
            if (Array.isArray(order))
              browser[k] = JSON.stringify(
                order.map((x) => mapKey(String(x))).filter((x): x is string => Boolean(x)),
              );
          } catch {
            /* a broken order is left out */
          }
        } else browser[k] = v;
      }
    return { deskLayouts, browser, missing: [...missing].sort() };
  }
}

export class LayoutError extends Error {}
