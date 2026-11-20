import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import type { HeldChange } from "./staged";
import { lookup } from "node:dns/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { mkdirSync, renameSync, statSync } from "node:fs";
import type {
  BrowserControl,
  BrowserHandover,
  BrowserOwnerInput,
  BrowserPage,
  BrowserState,
  BrowserVisibleAsk,
} from "@dragon-control/core";
import type { SessionMaterial } from "./signin";

/**
 * Ember's Browser (checklist 45.12, phase C): a real browser that Hearth runs for Ember, which
 * the owner watches live in its panel. Every agent (Claude Code, Codex, Ollama) uses it through
 * the same Hearth tool, so there is one browser and one set of rules, not one per agent.
 *
 * - It is the installed Edge or Chrome (Chromium on Linux), headless, driven over the Chrome
 *   DevTools Protocol on a loopback port nobody else is told about. A site that refuses the
 *   background browser can open in a normal visible window on this machine's screen instead,
 *   when the owner says yes (45.19). It is never disguised: no faked browser details, no other
 *   networks; a site that refuses the visible window too is left alone.
 * - Each session has a new, empty profile: no logins, cookies or history of the owner's. The
 *   profile is deleted when the session closes (idle, closed by the owner, or Hearth stopping).
 * - What it may do depends on the operation, not on it being a browser (11-03):
 *   - public websites: browse, search, fill in and send ordinary forms, download;
 *   - the owner's apps registered in Hearth (on any address of theirs): open, signed in through
 *     Secure Vault when the owner allowed that credential (signin.ts), and read; a change sent
 *     to an app (anything but a read) needs Full access or an approved browser-change plan, the
 *     same rule as app_api, and is refused while the owner asked only to look;
 *   - protected systems (VPN, proxy, firewall, Hearth itself) are never changed from it;
 *   - any other address on the owner's network or this machine is refused: add it to Hearth
 *     first;
 *   - a page from another site never reaches the owner's apps (no cross-site requests to them).
 * - Password boxes are never typed into: sign-ins are Hearth's, server side.
 * - What Ember reads on a signed-in app has that app's secrets hidden, and a picture of a page
 *   that shows one is refused.
 * - The live picture is the page's own screencast; the click marker is drawn where Hearth itself
 *   sent the click, so nothing on screen is simulated.
 */

const VIEW = { width: 1280, height: 800 };

/** A link's address worth opening when its click went nowhere: a real page, not this one's anchor. */
export function followable(href: string, current: string): boolean {
  try {
    const to = new URL(href);
    if (to.protocol !== "http:" && to.protocol !== "https:") return false;
    const here = new URL(current);
    to.hash = "";
    here.hash = "";
    return to.href !== here.href;
  } catch {
    return false;
  }
}

/** The sizes the page may take to fill the panel (11-04: no empty space). */
const VIEW_MIN = { width: 640, height: 400 };
const VIEW_MAX = { width: 2560, height: 1600 };
const IDLE_MS = 10 * 60_000;
const LEASE_MS = 60 * 60_000;
const LOAD_MS = 20_000;

type Json = Record<string, unknown>;
type Pending = { resolve: (v: Json) => void; reject: (e: Error) => void };

interface Tab {
  id: string;
  session: string;
  url: string;
  title: string;
  viewers: Set<ServerResponse>;
  frame?: Buffer;
  casting: boolean;
  /** The refs of the controls from the last read, so a click names one the page really has. */
  refs: Map<string, BrowserControl>;
}

export class BrowserError extends Error {}

/** Where an installed browser is, most popular first. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.DC_BROWSER_PATH && existsSync(env.DC_BROWSER_PATH)) return env.DC_BROWSER_PATH;
  const candidates =
    process.platform === "win32"
      ? [
          "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
          "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
          "C:/Program Files/Google/Chrome/Application/chrome.exe",
          `${env.LOCALAPPDATA ?? ""}/Google/Chrome/Application/chrome.exe`,
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
            "/usr/bin/microsoft-edge",
          ];
  return candidates.find((c) => c && existsSync(c));
}

let screenCache: boolean | undefined;
/**
 * Whether a visible window can open here: a desktop session on Linux (X11 or Wayland), an
 * interactive session on Windows (not a service's session 0), always on a Mac.
 */
export function hasScreen(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DC_BROWSER_SCREEN === "0") return false;
  if (env.DC_BROWSER_SCREEN === "1") return true;
  if (screenCache !== undefined) return screenCache;
  if (process.platform === "darwin") screenCache = true;
  else if (process.platform === "win32") {
    try {
      const row = execFileSync("tasklist", ["/FI", `PID eq ${process.pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
      });
      // "node.exe","1234","Console","1","50,000 K": the fourth field is the session.
      const session = Number(/^"[^"]*","\d+","[^"]*","(\d+)"/m.exec(row)?.[1] ?? "0");
      screenCache = session > 0;
    } catch {
      screenCache = false;
    }
  } else screenCache = Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  return screenCache;
}

/** An answer that means the site refuses the browser itself (not a page that is missing). */
export function isRefusal(status: number | undefined) {
  return status === 401 || status === 403 || status === 429;
}

/** True for an address on the owner's own network or this machine (never opened in phase C). */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      // Tailscale and carrier-grade NAT.
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return (
    v6 === "::1" ||
    v6 === "::" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe8") ||
    v6.startsWith("fe9") ||
    v6.startsWith("fea") ||
    v6.startsWith("feb")
  );
}

/** One of the owner's apps, as the browser may reach it. */
export interface ServiceScope {
  serviceId: string;
  name: string;
  origin: string;
  /** VPN, proxy, firewall, Hearth itself: never changed from the browser. */
  protected: boolean;
}

export interface BrowserOptions {
  /** Tests only: allow this machine's own addresses (a local test page). Never in production. */
  allowLocal?: boolean;
  /** The owner's app at this origin, if it is one registered in Hearth. */
  scope?: (origin: string) => Promise<ServiceScope | undefined>;
  /** Signs in to the app server side (credential broker): only the session comes back. */
  signIn?: (s: ServiceScope) => Promise<SessionMaterial>;
  /** Why a change to this app may not be sent now (or nothing when it may). */
  mayChange?: (s: ServiceScope) => Promise<string | undefined>;
  /**
   * A change that may not be sent now is held instead (not sent): its exact request, for the
   * owner to approve on its own. Without this, it is only refused.
   */
  stage?: (input: {
    serviceId: string;
    serviceName: string;
    origin: string;
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
    cookie?: string;
    authorization?: string;
  }) => Promise<HeldChange>;
  /** The app's own secrets, so nothing Ember reads shows one (never returned anywhere). */
  secrets?: (s: ServiceScope) => Promise<string[]>;
  /** Where downloads go (a folder of Hearth's); without one, downloads are refused. */
  downloads?: string;
  /** The sites the owner allowed to always open in a visible window (kept in Hearth's settings). */
  visibleSites?: { load: () => Promise<string[]>; save: (hosts: string[]) => Promise<void> };
  /** Tests only: a visible window still starts headless (no screen in tests). */
  testHeadless?: boolean;
  /** Tests only: how long unused before it closes itself (ten minutes otherwise). */
  idleMs?: number;
  /** Something happened worth telling (the panel's state, the audit). */
  onChange?: () => void;
  resolve?: (host: string) => Promise<string[]>;
}

/** The keys Ember's browser may press (menus and forms; nothing that types a value). */
const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Escape: { code: "Escape", vk: 27 },
  Tab: { code: "Tab", vk: 9 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  Space: { code: "Space", vk: 32, text: " " },
  PageDown: { code: "PageDown", vk: 34 },
  PageUp: { code: "PageUp", vk: 33 },
};
/** Keys the owner can press on the page while they have it (Ember's list, plus editing keys). */
const OWNER_KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  ...KEYS,
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
};
const HANDOVER = "handover";
type Handed = BrowserHandover;

export class EmberBrowser {
  private proc?: ChildProcess;
  private ws?: WebSocket;
  private profile?: string;
  private starting?: Promise<void>;
  private next = 1;
  private waiting = new Map<number, Pending>();
  private tabs = new Map<string, Tab>();
  private emberTab?: string;
  private pointer?: BrowserState["pointer"];
  private last?: BrowserState["last"];
  private idle?: NodeJS.Timeout;
  private idleAt?: number;
  private blocked?: { url: string; why: string; at: string };
  private hosts = new Map<string, Promise<string | undefined>>();
  private loads = new Map<string, () => void>();
  /** Tabs Hearth opened itself; a page the browser opens on its own while starting is closed. */
  private ours = new Set<string>();
  private launching = false;
  /** Hearth is opening a tab right now: the page that attaches meanwhile is that tab. */
  private creating = 0;
  /** Apps signed in to in this session, by origin (the session material stays here). */
  private signed = new Map<
    string,
    {
      scope: ServiceScope;
      state: "signed-in" | "not-signed-in";
      how: string;
      material?: SessionMaterial;
    }
  >();
  private scopes = new Map<string, { at: number; scope: Promise<ServiceScope | undefined> }>();
  private files: NonNullable<BrowserState["downloads"]> = [];
  private fileNames = new Map<string, string>();
  /** The owner asked only to look (set per tool call): changes to apps are refused. */
  private looking = false;
  /** Changes held for approval in this session (summaries only), and those Ember has not seen. */
  private heldAll: HeldChange[] = [];
  /** Tasks using the browser now (conversation id to when the lease lapses): no idle close. */
  private working = new Map<string, number>();
  private heldNew: HeldChange[] = [];
  private said?: BrowserState["caption"];
  /** The owner has the page, and the conversation to carry on when they give it back. */
  private handed?: Handed;
  /** A normal visible window on this machine's screen, not the background browser (45.19). */
  private visible = false;
  private asked?: BrowserVisibleAsk;
  private sites?: Set<string>;
  /** The page's size: the panel's shape, so the picture fills it. */
  private view = { ...VIEW };

  constructor(private readonly opts: BrowserOptions = {}) {}

  /** What the panel shows: whether it is running, its tabs, where Ember last clicked. */
  state(): BrowserState {
    const exe = findBrowser();
    return {
      status: this.ws ? "live" : this.starting ? "starting" : exe ? "off" : "unavailable",
      ...(exe ? {} : { reason: "No Edge, Chrome or Chromium is installed on this machine." }),
      tabs: [...this.tabs.values()].map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        ember: t.id === this.emberTab,
      })),
      window: this.visible ? "visible" : "background",
      screen: hasScreen(),
      ...(this.asked ? { visibleAsk: { ...this.asked } } : {}),
      visibleSites: [...(this.sites ?? [])].sort(),
      viewport: { ...this.view },
      ...(this.pointer ? { pointer: this.pointer } : {}),
      ...(this.last ? { last: this.last } : {}),
      ...(this.said ? { caption: this.said } : {}),
      ...(this.blocked ? { blocked: this.blocked } : {}),
      ...(this.handed ? { handover: { ...this.handed } } : {}),
      ...(this.idleAt ? { idleClosesAt: new Date(this.idleAt).toISOString() } : {}),
      signedIn: [...this.signed.entries()].map(([origin, v]) => ({
        origin,
        service: v.scope.name,
        state: v.state,
        how: v.how,
      })),
      downloads: this.files.slice(-20),
      held: this.held(),
    };
  }

  /**
   * A task is using the browser (each tool call renews it): the idle close waits until the task
   * ends, for at most an hour after its last call, so it never closes under an active task.
   */
  use(task: string | undefined) {
    if (!task) return;
    this.working.set(task, Date.now() + LEASE_MS);
  }

  /** The task ended: the browser may close itself again when idle. */
  release(task: string) {
    this.working.delete(task);
  }

  private busy() {
    const now = Date.now();
    for (const [k, until] of this.working) if (until <= now) this.working.delete(k);
    return this.working.size > 0;
  }

  /** Changes held for approval and not expired (summaries only). */
  held(): HeldChange[] {
    const now = Date.now();
    this.heldAll = this.heldAll.filter((h) => Date.parse(h.expiresAt) > now).slice(-20);
    return this.heldAll;
  }

  /** Changes held since Ember last asked: each tool answer says what it held. */
  takeHeld(): HeldChange[] {
    const out = this.heldNew;
    this.heldNew = [];
    return out;
  }

  /** For this call: the owner asked only to look, so changes to apps are refused. */
  lookOnly(on: boolean) {
    this.looking = on;
  }

  /**
   * Hands the page to the owner (checklist 45.18): Ember is stuck on something a person should do
   * (a CAPTCHA, a password, a sign-in), or the owner pressed Take over. Ember's own actions wait
   * until it is given back; the browser stays open meanwhile (up to an hour).
   */
  handOver(reason: string, by: "ember" | "owner", conversationId?: string): BrowserPage {
    const tab = this.tab();
    this.handed = {
      reason: reason.trim().slice(0, 200) || "Take over",
      by,
      at: new Date().toISOString(),
      ...(conversationId ? { conversationId } : {}),
    };
    this.use(HANDOVER);
    this.note(by === "ember" ? `Needs you: ${this.handed.reason}` : "You took over", by);
    return this.page(tab);
  }

  /** The owner gives the page back: what they had it for, and the page it is on now. */
  giveBack(): { handed?: Handed; page?: BrowserPage } {
    const handed = this.handed;
    this.handed = undefined;
    this.release(HANDOVER);
    const tab = this.emberTab ? this.tabs.get(this.emberTab) : undefined;
    if (handed) this.note("You gave the browser back", "owner");
    return { ...(handed ? { handed } : {}), ...(tab ? { page: this.page(tab) } : {}) };
  }

  private async siteList(): Promise<Set<string>> {
    this.sites ??= new Set(
      ((await this.opts.visibleSites?.load()) ?? []).map((h) => h.toLowerCase()),
    );
    return this.sites;
  }

  /** Loads the always-allowed sites, so the panel lists them before the browser is used. */
  async loadSites() {
    await this.siteList();
  }

  /**
   * A site refuses the background browser (45.19): Ember asks to open it in a visible window on
   * this machine. A site the owner always allows opens straight away; otherwise the ask waits for
   * the owner's answer (and Ember ends her answer).
   */
  async askVisible(
    url: string,
    reason: string,
    conversationId?: string,
  ): Promise<{ opened: BrowserPage } | { asked: BrowserVisibleAsk }> {
    this.mine();
    if (!hasScreen())
      throw new BrowserError(
        "This machine has no screen for a visible window (Hearth runs here without a desktop).",
      );
    const target = await this.allowed(url);
    const host = hostOf(target);
    if (this.visible && this.ws)
      throw new BrowserError(
        `The browser is already a visible window, and ${host} still refuses it. Leave it: give the owner the link for their own browser.`,
      );
    if ((await this.siteList()).has(host)) return { opened: await this.goVisible(target) };
    this.asked = {
      host,
      url: target,
      reason: reason.trim().slice(0, 200) || `${host} refuses the background browser`,
      at: new Date().toISOString(),
      ...(conversationId ? { conversationId } : {}),
    };
    this.note(`Asks to open ${host} in a visible window`, "ember");
    return { asked: { ...this.asked } };
  }

  /** The owner's answer to the ask: open it (once, or always for that site), or not. */
  async answerVisible(
    answer: "yes" | "always" | "no",
  ): Promise<{ asked?: BrowserVisibleAsk; page?: BrowserPage }> {
    const asked = this.asked;
    this.asked = undefined;
    if (!asked) return {};
    if (answer === "no") {
      this.note(`You said no to a visible window for ${asked.host}`, "owner");
      return { asked };
    }
    if (answer === "always") {
      const sites = await this.siteList();
      sites.add(asked.host);
      await this.opts.visibleSites?.save([...sites]);
    }
    return { asked, page: await this.goVisible(asked.url) };
  }

  /** Takes a site off the always-allowed list. */
  async forgetSite(host: string) {
    const sites = await this.siteList();
    sites.delete(host.toLowerCase());
    await this.opts.visibleSites?.save([...sites]);
    this.opts.onChange?.();
  }

  /** The browser starts again as a visible window (a fresh profile, as always) on the address. */
  private async goVisible(url: string): Promise<BrowserPage> {
    await this.close();
    this.visible = true;
    const page = await this.open(url, "ember");
    this.note(`Opened ${hostOf(page.url)} in a visible window`, "ember");
    return page;
  }

  /** Show & Tell: what Ember says to notice now, for the panel to show and read aloud. */
  caption(text: string) {
    this.said = { text: text.slice(0, 200), at: new Date().toISOString() };
    this.opts.onChange?.();
  }

  /** While the owner has the page, Ember waits. */
  private mine() {
    if (this.handed)
      throw new BrowserError(
        `The owner has Ember's Browser right now (${this.handed.reason}). Do nothing in it: when they press Give it back, Hearth tells you and you carry on.`,
      );
  }

  /**
   * What the owner does on the page while they have it: a click where they clicked on the picture,
   * typing, a key, scrolling. Nothing they type is recorded, noted or shown to the AI.
   */
  async ownerInput(input: BrowserOwnerInput, tabId?: string): Promise<BrowserPage> {
    if (!this.handed) throw new BrowserError("Press Take over first.");
    const tab = this.tab(tabId);
    if (input.kind === "click") {
      // The picture is the page's viewport: the share of it becomes the page's own position.
      const m = (await this.send("Page.getLayoutMetrics", {}, tab)) as {
        cssLayoutViewport?: { clientWidth: number; clientHeight: number };
      };
      const w = m.cssLayoutViewport?.clientWidth ?? this.view.width;
      const h = m.cssLayoutViewport?.clientHeight ?? this.view.height;
      const share = (v: number) => Math.max(0, Math.min(1, v));
      const x = Math.min(w - 1, Math.round(share(input.fx) * w));
      const y = Math.min(h - 1, Math.round(share(input.fy) * h));
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, tab);
      for (const type of ["mousePressed", "mouseReleased"])
        await this.send(
          "Input.dispatchMouseEvent",
          { type, x, y, button: "left", clickCount: 1 },
          tab,
        );
    } else if (input.kind === "type") {
      await this.send("Input.insertText", { text: input.text.slice(0, 500) }, tab);
    } else if (input.kind === "key") {
      const k = OWNER_KEYS[input.key];
      if (!k) throw new BrowserError(`Keys: ${Object.keys(OWNER_KEYS).join(", ")}.`);
      for (const type of ["keyDown", "keyUp"])
        await this.send(
          "Input.dispatchKeyEvent",
          {
            type,
            key: input.key === "Space" ? " " : input.key,
            code: k.code,
            windowsVirtualKeyCode: k.vk,
            ...(k.text && type === "keyDown" ? { text: k.text } : {}),
          },
          tab,
        );
    } else {
      await this.send(
        "Input.dispatchMouseEvent",
        {
          type: "mouseWheel",
          x: this.view.width / 2,
          y: this.view.height / 2,
          deltaX: 0,
          deltaY: Math.max(-2000, Math.min(2000, input.dy)),
        },
        tab,
      );
    }
    this.use(HANDOVER);
    this.touch();
    return this.page(tab);
  }

  /** How it stands with signing in to the app the page is on, for Ember's answer. */
  signInFor(url: string) {
    const o = originOf(url);
    const v = o ? this.signed.get(o) : undefined;
    return v ? { service: v.scope.name, state: v.state, how: v.how } : undefined;
  }

  /* ------------------------------ what Ember (and the owner) can do ---------------------------- */

  /** Opens an address in Ember's tab (a new tab with `newTab`). */
  async open(url: string, by: "ember" | "owner", newTab = false): Promise<BrowserPage> {
    if (by === "ember") this.mine();
    const target = await this.allowed(url);
    await this.ensure();
    // Ember's tab, else the blank page the browser started with, else a new one.
    let tab = this.emberTab ? this.tabs.get(this.emberTab) : [...this.tabs.values()][0];
    if (!tab || newTab) tab = await this.newTab();
    if (by === "ember" || !this.emberTab) this.emberTab = tab.id;
    await this.send("Page.bringToFront", {}, tab).catch(() => undefined);
    await this.session(target);
    await this.navigate(tab, target);
    this.note(`Opened ${hostOf(tab.url)}`, by);
    // The page's own answer: a refusal (403) is told to Ember, so she does not read it as content.
    const status = Number(
      await this.eval(
        tab,
        `(performance.getEntriesByType("navigation")[0] || {}).responseStatus || 0`,
      ).catch(() => 0),
    );
    return { ...this.page(tab), ...(status ? { status } : {}) };
  }

  /** The page as text, with the controls on it (each with a ref to click or type into). */
  async read(
    tabId?: string,
  ): Promise<BrowserPage & { text: string; lead: string; controls: BrowserControl[] }> {
    const tab = this.tab(tabId);
    const got = (await this.eval(
      tab,
      `(() => {
        const shown = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
          return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
        const name = (e) => (e.getAttribute("aria-label") || e.innerText || e.value || e.placeholder ||
          e.getAttribute("title") || e.getAttribute("alt") || "").replace(/\\s+/g, " ").trim().slice(0, 80);
        const LEAF = 'a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=option], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=combobox], [role=treeitem]';
        const picked = new Set([...document.querySelectorAll(LEAF + ', [onclick], [tabindex]:not([tabindex="-1"])')].filter(shown));
        // Custom controls (a menu option drawn as a plain element with only a click handler): the
        // outermost element that shows a pointing hand, not inside a control already listed.
        const all = document.body ? document.body.querySelectorAll("*") : [];
        for (let i = 0; i < all.length && picked.size < 400; i++) {
          const e = all[i];
          if (picked.has(e) || getComputedStyle(e).cursor !== "pointer") continue;
          const p = e.parentElement;
          if (p && getComputedStyle(p).cursor === "pointer") continue;
          if (p && p.closest(LEAF)) continue;
          if (!shown(e) || !(e.innerText || e.getAttribute("aria-label") || "").trim()) continue;
          picked.add(e);
        }
        // An open pop-up menu whose choices are plain elements (no role, no pointing hand): in a
        // layer drawn over the page, a run of alike siblings with short text is its list of choices.
        for (let i = 0; i < all.length && picked.size < 400; i++) {
          const layer = all[i];
          const pos = getComputedStyle(layer).position;
          if ((pos !== "absolute" && pos !== "fixed") || !shown(layer)) continue;
          // A pop-up, not a page laid out in a fixed frame, and each layer scanned once.
          const lr = layer.getBoundingClientRect();
          if (lr.width * lr.height > 0.6 * innerWidth * innerHeight) continue;
          if (layer.parentElement && layer.parentElement.closest("[data-ember-layer]")) continue;
          layer.setAttribute("data-ember-layer", "");
          for (const e of layer.querySelectorAll("*")) {
            const p = e.parentElement;
            if (!p || picked.has(e) || !e.className || typeof e.className !== "string") continue;
            const alike = [...p.children].filter((x) => x.className === e.className);
            const words = (e.innerText || "").trim();
            if (alike.length < 2 || !words || words.length > 80 || e.closest(LEAF)) continue;
            if (alike.some((x) => picked.has(x) || x.querySelector("[data-ember-pick]"))) continue;
            for (const x of alike) if (shown(x)) { picked.add(x); x.setAttribute("data-ember-pick", ""); }
          }
        }
        document.querySelectorAll("[data-ember-pick], [data-ember-layer]").forEach((e) => {
          e.removeAttribute("data-ember-pick");
          e.removeAttribute("data-ember-layer");
        });
        // What is on screen first (an open menu is), then the rest of the page, in page order.
        const inView = (e) => { const r = e.getBoundingClientRect();
          return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
        const order = (a, b) => (a.compareDocumentPosition(b) & 4 ? -1 : 1);
        const els = [...picked].sort(order)
          .map((e, i) => ({ e, k: (inView(e) ? 0 : 100000) + i }))
          .sort((a, b) => a.k - b.k).slice(0, 160).map((x) => x.e).sort(order);
        document.querySelectorAll("[data-ember-ref]").forEach((e) => e.removeAttribute("data-ember-ref"));
        let n = 0;
        const controls = els.map((e) => {
          const ref = "e" + (++n);
          e.setAttribute("data-ember-ref", ref);
          const tag = e.tagName.toLowerCase();
          const aria = e.getAttribute("role");
          const role = tag === "a" ? "link" : tag === "input" ? (e.type || "text") : tag === "select" ? "select"
            : tag === "textarea" ? "text" : aria && aria !== "button" ? aria : "button";
          if (tag === "select") {
            const label = (e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute("aria-label") || e.name || "";
            return { ref, role, name: label.replace(/\\s+/g, " ").trim().slice(0, 80),
              options: [...e.options].slice(0, 40).map((o) => o.label.trim().slice(0, 60)),
              value: e.selectedOptions[0] ? e.selectedOptions[0].label.trim() : "" };
          }
          const on = tag === "input" && (e.type === "checkbox" || e.type === "radio") ? e.checked
            : e.getAttribute("aria-checked") === "true" || e.getAttribute("aria-selected") === "true"
              ? true : e.hasAttribute("aria-checked") || e.hasAttribute("aria-selected") ? false : undefined;
          return { ref, role, name: name(e), ...(tag === "a" ? { href: e.href } : {}),
            ...(on !== undefined ? { checked: on } : {}) };
        });
        // The page's own content (not its menus), for the evidence card's excerpt.
        const main = document.querySelector("main, article, [role=main]");
        const h1 = document.querySelector("h1");
        const lead = ((main && main.innerText) || (h1 && h1.parentElement && h1.parentElement.innerText) || "")
          .replace(/\\s+/g, " ").trim().slice(0, 600);
        return { text: (document.body?.innerText || "").replace(/\\n{3,}/g, "\\n\\n").slice(0, 8000), lead, controls };
      })()`,
    )) as { text: string; lead: string; controls: BrowserControl[] };
    // On a signed-in app, its secrets never leave in what Ember reads (some pages print a key).
    const hide = await this.secretsFor(tab.url);
    const clean = (v: string) => scrubSecrets(v, hide);
    const controls = got.controls.map((c) => ({ ...c, name: clean(c.name) }));
    tab.refs = new Map(controls.map((c) => [c.ref, c]));
    this.note(`Read ${tab.title || hostOf(tab.url)}`, "ember");
    return { ...this.page(tab), text: clean(got.text), lead: clean(got.lead), controls };
  }

  /** Clicks a control from the last read, at its real place on the page. */
  async click(ref: string): Promise<BrowserPage> {
    this.mine();
    const tab = this.tab();
    const c = tab.refs.get(ref);
    if (!c)
      throw new BrowserError(`No control "${ref}" on this page. Read the page again for refs.`);
    if (c.href) {
      await this.allowed(c.href);
      await this.session(c.href);
    }
    const box = await this.box(tab, ref);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y }, tab);
    this.point(tab, box, "click");
    const before = {
      url: tab.url,
      tabs: this.tabs.size,
      ember: this.emberTab,
      blocked: this.blocked,
      held: this.heldAll.length,
      files: this.files.length,
    };
    const loaded = this.waitLoad(tab, 6000);
    for (const type of ["mousePressed", "mouseReleased"])
      await this.send(
        "Input.dispatchMouseEvent",
        { type, x: box.x, y: box.y, button: "left", clickCount: 1 },
        tab,
      );
    await loaded;
    await this.refresh(tab);
    // A link that went nowhere (something lay over it, or the site's own script swallowed the
    // click): open its address, which is where the click leads (11-04, Rotten Tomatoes).
    // Never when Hearth itself stopped it (a held change or a refused site), and not a download
    // (the page stays put while the file comes): those stay as they are.
    const went = () =>
      tab.url !== before.url ||
      this.tabs.size !== before.tabs ||
      this.emberTab !== before.ember ||
      this.blocked !== before.blocked ||
      this.heldAll.length !== before.held ||
      this.files.length !== before.files;
    if (c.href && !went() && followable(c.href, before.url))
      await new Promise((r) => setTimeout(r, 500));
    if (c.href && !went() && followable(c.href, before.url)) {
      await this.navigate(tab, c.href);
      await this.refresh(tab);
      this.note(`Opened the link "${c.name || ref}" (the click itself did not go there)`, "ember");
      return this.page(tab);
    }
    this.note(`Clicked "${c.name || ref}"`, "ember");
    return this.page(tab);
  }

  /** Types into a box from the last read (never a password box); Enter with `submit`. */
  async type(ref: string, text: string, submit = false): Promise<BrowserPage> {
    this.mine();
    const tab = this.tab();
    const c = tab.refs.get(ref);
    if (!c)
      throw new BrowserError(`No control "${ref}" on this page. Read the page again for refs.`);
    if (c.role === "password")
      throw new BrowserError("Ember's browser never types into a password box.");
    if (!["text", "search", "email", "url", "number", "tel"].includes(c.role))
      throw new BrowserError(`"${c.name || ref}" is not a box to type into.`);
    const box = await this.box(tab, ref);
    this.point(tab, box, "type");
    await this.eval(
      tab,
      `(() => { const e = document.querySelector('[data-ember-ref="${ref}"]'); e.focus(); e.value = ""; })()`,
    );
    await this.send("Input.insertText", { text: text.slice(0, 500) }, tab);
    if (submit) {
      const loaded = this.waitLoad(tab, 8000);
      for (const type of ["keyDown", "keyUp"])
        await this.send(
          "Input.dispatchKeyEvent",
          { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
          tab,
        );
      await loaded;
      await this.refresh(tab);
    }
    this.note(`Typed into "${c.name || ref}"${submit ? " and pressed Enter" : ""}`, "ember");
    return this.page(tab);
  }

  /** Chooses an option in a dropdown list (select) from the last read, by its label or value. */
  async choose(ref: string, option: string): Promise<BrowserPage> {
    this.mine();
    const tab = this.tab();
    const c = tab.refs.get(ref);
    if (!c)
      throw new BrowserError(`No control "${ref}" on this page. Read the page again for refs.`);
    if (c.role !== "select")
      throw new BrowserError(
        `"${c.name || ref}" is not a dropdown list: click it, then click the option (read again to see it).`,
      );
    const box = await this.box(tab, ref);
    this.point(tab, box, "click");
    const picked = (await this.eval(
      tab,
      `((want) => { const e = document.querySelector('[data-ember-ref="${ref}"]'); if (!e) return null;
        const w = want.trim().toLowerCase();
        const o = [...e.options].find((x) => x.label.trim().toLowerCase() === w || x.value.toLowerCase() === w)
          || [...e.options].find((x) => x.label.trim().toLowerCase().startsWith(w));
        if (!o) return { missing: [...e.options].map((x) => x.label.trim()).slice(0, 40) };
        e.focus();
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(e, o.value);
        e.dispatchEvent(new Event("input", { bubbles: true }));
        e.dispatchEvent(new Event("change", { bubbles: true }));
        return { chose: o.label.trim() }; })(${JSON.stringify(option.slice(0, 200))})`,
    )) as { chose?: string; missing?: string[] } | null;
    if (!picked)
      throw new BrowserError("That control is no longer on the page. Read the page again.");
    if (picked.missing)
      throw new BrowserError(
        `"${c.name || ref}" has no option "${option}". Its options: ${picked.missing.join(", ")}.`,
      );
    await this.refresh(tab);
    this.note(`Chose "${picked.chose}" in "${c.name || ref}"`, "ember");
    return this.page(tab);
  }

  /** Presses one key on the page (to move through a menu, close it, or confirm). */
  async key(key: string): Promise<BrowserPage> {
    this.mine();
    const tab = this.tab();
    const k = KEYS[key];
    if (!k) throw new BrowserError(`Ember's browser can press: ${Object.keys(KEYS).join(", ")}.`);
    const loaded = key === "Enter" ? this.waitLoad(tab, 6000) : Promise.resolve();
    for (const type of ["keyDown", "keyUp"])
      await this.send(
        "Input.dispatchKeyEvent",
        {
          type,
          key: key === "Space" ? " " : key,
          code: k.code,
          windowsVirtualKeyCode: k.vk,
          ...(k.text && type === "keyDown" ? { text: k.text } : {}),
        },
        tab,
      );
    await loaded;
    await this.refresh(tab);
    this.note(`Pressed ${key}`, "ember");
    return this.page(tab);
  }

  async history(step: "back" | "forward" | "reload", by: "ember" | "owner", tabId?: string) {
    if (by === "ember") this.mine();
    const tab = this.tab(tabId);
    const loaded = this.waitLoad(tab, 8000);
    if (step === "reload") await this.send("Page.reload", {}, tab);
    else {
      const h = (await this.send("Page.getNavigationHistory", {}, tab)) as {
        currentIndex: number;
        entries: { id: number; url: string }[];
      };
      const e = h.entries[h.currentIndex + (step === "back" ? -1 : 1)];
      if (!e) return this.page(tab);
      await this.allowed(e.url);
      await this.send("Page.navigateToHistoryEntry", { entryId: e.id }, tab);
    }
    await loaded;
    await this.refresh(tab);
    this.note(step === "reload" ? "Reloaded the page" : `Went ${step}`, by);
    return this.page(tab);
  }

  /** A picture of Ember's page, for evidence. */
  async screenshot(tabId?: string): Promise<{ page: BrowserPage; jpeg: string }> {
    const tab = this.tab(tabId);
    const hide = await this.secretsFor(tab.url);
    if (hide.length) {
      const shown = String(
        await this.eval(
          tab,
          `(document.body?.innerText || "") + " " + [...document.querySelectorAll("input,textarea")].map((e) => e.value).join(" ")`,
        ),
      );
      if (hide.some((x) => shown.includes(x)))
        throw new BrowserError(
          "This page shows one of the app's secrets (a key or password), so no picture of it is taken. Read it instead: secrets are hidden there.",
        );
    }
    const r = (await this.send("Page.captureScreenshot", { format: "jpeg", quality: 70 }, tab)) as {
      data: string;
    };
    return { page: this.page(tab), jpeg: r.data };
  }

  /** Closes the browser and deletes its profile. */
  async close() {
    this.handed = undefined;
    this.said = undefined;
    this.asked = undefined;
    // The next start is the background browser again.
    this.visible = false;
    this.release(HANDOVER);
    clearTimeout(this.idle);
    this.idleAt = undefined;
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      try {
        ws.send(JSON.stringify({ id: this.next++, method: "Browser.close" }));
      } catch {
        // already gone
      }
      ws.close();
    }
    for (const t of this.tabs.values()) for (const v of t.viewers) v.end();
    this.tabs.clear();
    this.emberTab = undefined;
    this.pointer = undefined;
    this.signed.clear();
    this.scopes.clear();
    for (const p of this.waiting.values()) p.reject(new BrowserError("The browser closed."));
    this.waiting.clear();
    const proc = this.proc;
    this.proc = undefined;
    if (proc && proc.exitCode === null) {
      await new Promise((r) => {
        const t = setTimeout(r, 2000);
        proc.once("exit", () => (clearTimeout(t), r(undefined)));
      });
      if (proc.exitCode === null) proc.kill();
    }
    if (this.profile) {
      const dir = this.profile;
      this.profile = undefined;
      // Windows keeps the profile's files a moment after the browser exits.
      for (let i = 0; i < 10; i++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    }
    this.opts.onChange?.();
  }

  /** The live picture of one tab, as MJPEG, for as long as the viewer stays. */
  watch(tabId: string | undefined, res: ServerResponse) {
    const tab = tabId
      ? this.tabs.get(tabId)
      : this.emberTab
        ? this.tabs.get(this.emberTab)
        : undefined;
    res.writeHead(200, {
      "Content-Type": "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    // The headers go now, so the viewer is connected even before the page paints.
    res.flushHeaders();
    res.write("--frame\r\n");
    if (!tab) {
      res.end();
      return;
    }
    tab.viewers.add(res);
    if (tab.frame) writeFrame(res, tab.frame);
    // A still page paints once, and an image shows a frame only once another follows: the
    // latest frame goes again each second nothing new came (it also keeps the line open).
    let sent = tab.frame;
    const again = setInterval(() => {
      if (tab.frame && tab.frame === sent) writeFrame(res, tab.frame);
      sent = tab.frame;
    }, 1000);
    res.on("close", () => {
      clearInterval(again);
      tab.viewers.delete(res);
      if (!tab.viewers.size && tab.casting) {
        tab.casting = false;
        void this.send("Page.stopScreencast", {}, tab).catch(() => undefined);
      }
    });
    // A background tab does not paint: the one being watched comes to the front.
    void this.send("Page.bringToFront", {}, tab).catch(() => undefined);
    if (!tab.casting) {
      tab.casting = true;
      void this.send(
        "Page.startScreencast",
        { format: "jpeg", quality: 70, maxWidth: this.view.width, maxHeight: this.view.height },
        tab,
      ).catch(() => undefined);
      // A still page that painted before anyone watched sends no new frame: take one now, so the
      // picture is the page as it is (not an older page from this tab), above all when the owner
      // has to click on it.
      void this.send("Page.captureScreenshot", { format: "jpeg", quality: 70 }, tab)
        .then((r) => {
          const frame = Buffer.from(String(r.data ?? ""), "base64");
          if (!frame.length) return;
          tab.frame = frame;
          for (const v of tab.viewers) writeFrame(v, frame);
        })
        .catch(() => undefined);
    }
    this.touch();
  }

  /**
   * The panel's size changed: the page takes that shape, so it fills the panel with no empty
   * space. Every tab gets it, and a tab being watched starts its picture again at the new size.
   */
  async resize(width: number, height: number): Promise<BrowserState["viewport"]> {
    const clamp = (v: number, lo: number, hi: number) =>
      Math.round(Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo)));
    const next = {
      width: clamp(width, VIEW_MIN.width, VIEW_MAX.width),
      height: clamp(height, VIEW_MIN.height, VIEW_MAX.height),
    };
    if (next.width === this.view.width && next.height === this.view.height) return { ...next };
    this.view = next;
    for (const tab of this.tabs.values()) {
      await this.send(
        "Emulation.setDeviceMetricsOverride",
        { ...next, deviceScaleFactor: 1, mobile: false },
        tab,
      ).catch(() => undefined);
      if (tab.casting) {
        await this.send("Page.stopScreencast", {}, tab).catch(() => undefined);
        await this.send(
          "Page.startScreencast",
          { format: "jpeg", quality: 70, maxWidth: next.width, maxHeight: next.height },
          tab,
        ).catch(() => undefined);
      }
    }
    this.opts.onChange?.();
    return { ...next };
  }

  /* ----------------------------------------- the browser ----------------------------------------- */

  private async ensure() {
    if (this.ws) return this.touch();
    this.starting ??= this.launch().finally(() => (this.starting = undefined));
    await this.starting;
    this.touch();
  }

  private async launch() {
    this.launching = true;
    try {
      try {
        await this.start();
      } catch (error) {
        // Right after a browser died, the next one can stop at once while the old one is still
        // letting go (Chrome's "profile in use"): clean up, wait a moment, and try once more.
        if (!(error instanceof BrowserError) || !/stopped|did not start/.test(error.message))
          throw error;
        await this.close();
        await new Promise((r) => setTimeout(r, 1500));
        await this.start();
      }
    } finally {
      this.launching = false;
    }
  }

  private async start() {
    const exe = findBrowser();
    if (!exe) throw new BrowserError("No Edge, Chrome or Chromium is installed on this machine.");
    this.profile = mkdtempSync(path.join(tmpdir(), "hearth-ember-browser-"));
    const proc = spawn(
      exe,
      [
        ...(this.visible && !this.opts.testHeadless ? [] : ["--headless=new"]),
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${this.profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-sync",
        "--disable-background-networking",
        "--disable-component-update",
        "--password-store=basic",
        "--disable-features=PasswordManagerOnboarding,AutofillServerCommunication",
        `--window-size=${this.view.width},${this.view.height}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: !this.visible },
    );
    this.proc = proc;
    const url = await new Promise<string>((resolve, reject) => {
      let err = "";
      const t = setTimeout(() => reject(new BrowserError("The browser did not start.")), 20_000);
      proc.stderr!.on("data", (c: Buffer) => {
        err += c.toString();
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
        if (m) {
          clearTimeout(t);
          resolve(m[1]!);
        }
      });
      proc.once("exit", (code) => {
        clearTimeout(t);
        reject(new BrowserError(`The browser stopped (${code}).`));
      });
    });
    proc.once("exit", () => {
      if (this.proc === proc) void this.close();
    });
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener(
        "error",
        () => reject(new BrowserError("No connection to the browser.")),
        {
          once: true,
        },
      );
    });
    ws.addEventListener("message", (ev) => this.onMessage(String(ev.data)));
    ws.addEventListener("close", () => {
      if (this.ws === ws) void this.close();
    });
    this.ws = ws;
    if (this.opts.downloads) {
      mkdirSync(this.opts.downloads, { recursive: true });
      await this.send("Browser.setDownloadBehavior", {
        behavior: "allowAndName",
        downloadPath: this.opts.downloads,
        eventsEnabled: true,
      });
    } else await this.send("Browser.setDownloadBehavior", { behavior: "deny" });
    // Every new page (a tab, a pop-up) is held until its rules are on.
    await this.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "page", exclude: false }],
    });
    // The blank page it started with goes: every tab Ember uses comes through the rules above.
    const targets = (await this.send("Target.getTargets")) as {
      targetInfos: { targetId: string; type: string }[];
    };
    for (const t of targets.targetInfos.filter(
      (x) => x.type === "page" && !this.tabs.has(x.targetId) && !this.visible,
    ))
      await this.send("Target.closeTarget", { targetId: t.targetId }).catch(() => undefined);
    this.opts.onChange?.();
  }

  private async newTab(): Promise<Tab> {
    const before = new Set(this.tabs.keys());
    this.creating++;
    let targetId: string;
    try {
      ({ targetId } = (await this.send("Target.createTarget", { url: "about:blank" })) as {
        targetId: string;
      });
    } finally {
      this.creating--;
    }
    this.ours.add(targetId);
    for (let i = 0; i < 50 && !this.tabs.has(targetId); i++)
      await new Promise((r) => setTimeout(r, 50));
    const tab = this.tabs.get(targetId) ?? [...this.tabs.values()].find((t) => !before.has(t.id));
    if (!tab) throw new BrowserError("The browser did not open a tab.");
    return tab;
  }

  private async attached(sessionId: string, targetId: string, waiting: boolean, openerId?: string) {
    // A page Hearth did not open and no page opened (the browser's own start page) is closed;
    // a pop-up a page opens stays, under the same rules.
    if (this.creating > 0 && !this.launching) this.ours.add(targetId);
    // A visible window keeps the page it starts with (closing its last page closes the window).
    if (this.visible && this.launching && !openerId) this.ours.add(targetId);
    if ((this.launching || !openerId) && !this.ours.has(targetId)) {
      await this.send("Target.closeTarget", { targetId }).catch(() => undefined);
      return;
    }
    const tab: Tab = {
      id: targetId,
      session: sessionId,
      url: "about:blank",
      title: "",
      viewers: new Set(),
      casting: false,
      refs: new Map(),
    };
    this.tabs.set(targetId, tab);
    try {
      await this.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, tab);
      await this.send("Page.enable", {}, tab);
      await this.send("Runtime.enable", {}, tab);
      await this.send(
        "Emulation.setDeviceMetricsOverride",
        { ...this.view, deviceScaleFactor: 1, mobile: false },
        tab,
      );
    } finally {
      if (waiting)
        await this.send("Runtime.runIfWaitingForDebugger", {}, tab).catch(() => undefined);
    }
    this.opts.onChange?.();
  }

  private onMessage(raw: string) {
    const m = JSON.parse(raw) as {
      id?: number;
      result?: Json;
      error?: { message: string };
      method?: string;
      params?: Json;
      sessionId?: string;
    };
    if (m.id !== undefined) {
      const p = this.waiting.get(m.id);
      if (!p) return;
      this.waiting.delete(m.id);
      if (m.error) p.reject(new BrowserError(m.error.message));
      else p.resolve(m.result ?? {});
      return;
    }
    const params = m.params ?? {};
    const tab = m.sessionId
      ? [...this.tabs.values()].find((t) => t.session === m.sessionId)
      : undefined;
    switch (m.method) {
      case "Target.attachedToTarget": {
        const info = params.targetInfo as { targetId: string; type: string; openerId?: string };
        if (info.type === "page")
          void this.attached(
            params.sessionId as string,
            info.targetId,
            params.waitingForDebugger === true,
            info.openerId,
          );
        break;
      }
      case "Target.detachedFromTarget": {
        const gone = [...this.tabs.values()].find((t) => t.session === params.sessionId);
        if (gone) {
          for (const v of gone.viewers) v.end();
          this.tabs.delete(gone.id);
          if (this.emberTab === gone.id) this.emberTab = [...this.tabs.keys()][0];
          this.opts.onChange?.();
        }
        break;
      }
      case "Fetch.requestPaused":
        if (tab) void this.screen(tab, params);
        break;
      case "Browser.downloadWillBegin": {
        const name = safeName(String(params.suggestedFilename ?? "download"));
        this.fileNames.set(String(params.guid), name);
        this.files.push({
          name,
          url: String(params.url ?? "").slice(0, 300),
          state: "downloading",
          bytes: 0,
          at: new Date().toISOString(),
        });
        this.note(`Downloading ${name}`, "ember");
        break;
      }
      case "Browser.downloadProgress": {
        const name = this.fileNames.get(String(params.guid));
        const f = name ? [...this.files].reverse().find((x) => x.name === name) : undefined;
        if (!f || !this.opts.downloads) break;
        f.bytes = Number(params.receivedBytes ?? 0);
        if (params.state === "completed") {
          const from = path.join(this.opts.downloads, String(params.guid));
          let to = path.join(this.opts.downloads, f.name);
          for (let i = 1; existsSync(to); i++)
            to = path.join(this.opts.downloads, `${i}-${f.name}`);
          try {
            renameSync(from, to);
            f.path = to;
            f.bytes = statSync(to).size;
          } catch {
            f.path = from;
          }
          f.state = "done";
          this.note(`Downloaded ${f.name}`, "ember");
        } else if (params.state === "canceled") f.state = "failed";
        this.opts.onChange?.();
        break;
      }
      case "Page.screencastFrame":
        if (tab) {
          const frame = Buffer.from(params.data as string, "base64");
          tab.frame = frame;
          for (const v of tab.viewers) writeFrame(v, frame);
          void this.send("Page.screencastFrameAck", { sessionId: params.sessionId }, tab).catch(
            () => undefined,
          );
        }
        break;
      case "Page.loadEventFired":
        if (tab) {
          this.loads.get(tab.id)?.();
          void this.refresh(tab);
        }
        break;
      case "Page.frameNavigated":
        if (tab && !(params.frame as { parentId?: string }).parentId) {
          tab.url = String((params.frame as { url: string }).url);
          tab.refs.clear();
          this.opts.onChange?.();
        }
        break;
    }
  }

  /** Every request the page makes, checked before it goes out. */
  private async screen(tab: Tab, p: Json) {
    const req = p.request as { url: string; method: string; headers?: Record<string, string> };
    const id = p.requestId as string;
    const document = p.resourceType === "Document";
    const verdict = await this.refusal(req.url, {
      method: req.method,
      document,
      from: originOf(tab.url),
    });
    // While the owner has the page, a sign-in or change in their own app is theirs to send.
    if (verdict && typeof verdict === "object" && this.handed) {
      await this.send("Fetch.continueRequest", { requestId: id }, tab).catch(() => undefined);
      return;
    }
    if (verdict && typeof verdict === "object") {
      await this.hold(tab, p, verdict.hold);
      return;
    }
    const why = verdict;
    // A signed-in app on HTTP basic sign-in: the header is added here, for that origin only.
    const o = originOf(req.url);
    const auth = !why && o ? this.signed.get(o)?.material?.authorization : undefined;
    if (auth) {
      const headers = Object.entries(req.headers ?? {})
        .filter(([k]) => k.toLowerCase() !== "authorization")
        .map(([name, value]) => ({ name, value }));
      headers.push({ name: "Authorization", value: auth });
      await this.send("Fetch.continueRequest", { requestId: id, headers }, tab).catch(
        () => undefined,
      );
      return;
    }
    if (why) {
      if (p.resourceType === "Document") {
        this.blocked = { url: req.url.slice(0, 200), why, at: new Date().toISOString() };
        this.opts.onChange?.();
      }
      await this.send(
        "Fetch.failRequest",
        { requestId: id, errorReason: "BlockedByClient" },
        tab,
      ).catch(() => undefined);
      return;
    }
    await this.send("Fetch.continueRequest", { requestId: id }, tab).catch(() => undefined);
  }

  /**
   * A change to one of the owner's apps that may not be sent now: held for approval (its exact
   * request, kept server side), and the page's request fails. Nothing reaches the app.
   */
  private async hold(tab: Tab, p: Json, scope: ServiceScope) {
    const req = p.request as {
      url: string;
      method: string;
      headers?: Record<string, string>;
      postData?: string;
      postDataEntries?: { bytes?: string }[];
    };
    const id = p.requestId as string;
    const o = originOf(req.url)!;
    try {
      const got = (await this.send("Network.getCookies", { urls: [req.url] }, tab).catch(() => ({
        cookies: [],
      }))) as { cookies?: { name: string; value: string }[] };
      const cookie = (got.cookies ?? []).map((c) => `${c.name}=${c.value}`).join("; ");
      const body =
        req.postData ??
        (req.postDataEntries?.length
          ? req.postDataEntries.map((e) => Buffer.from(e.bytes ?? "", "base64").toString()).join("")
          : undefined);
      const auth = this.signed.get(o)?.material?.authorization;
      const v = await this.opts.stage!({
        serviceId: scope.serviceId,
        serviceName: scope.name,
        origin: o,
        method: req.method,
        url: req.url,
        headers: req.headers ?? {},
        ...(body !== undefined ? { body } : {}),
        ...(cookie ? { cookie } : {}),
        ...(auth ? { authorization: auth } : {}),
      });
      this.heldAll.push(v);
      this.heldNew.push(v);
      this.blocked = {
        url: req.url.slice(0, 200),
        why: `Held for your approval, not sent: ${v.summary}`,
        at: new Date().toISOString(),
      };
      this.note(`Held a change to ${scope.name} for your approval`, "ember");
    } catch (error) {
      this.blocked = {
        url: req.url.slice(0, 200),
        why: `Not sent: ${error instanceof Error ? error.message : String(error)}`,
        at: new Date().toISOString(),
      };
      this.opts.onChange?.();
    }
    await this.send(
      "Fetch.failRequest",
      { requestId: id, errorReason: "BlockedByClient" },
      tab,
    ).catch(() => undefined);
  }

  /**
   * Why a request may not go out, or nothing when it may. `document` is a page load; `from` is
   * the origin of the page making the request. `{ hold }`: a change to that app, held for
   * approval instead of sent.
   */
  private async refusal(
    raw: string,
    req: { method?: string; document?: boolean; from?: string } = {},
  ): Promise<string | { hold: ServiceScope } | undefined> {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return "That is not a web address.";
    }
    if (u.protocol === "data:" || u.protocol === "blob:" || raw === "about:blank") return undefined;
    if (u.protocol !== "http:" && u.protocol !== "https:")
      return "Ember's browser opens web pages only (http and https).";
    if (u.username || u.password) return "Addresses with a login in them are not opened.";
    const host = u.hostname.replace(/^\[|\]$/g, "");
    // One of the owner's apps: reachable, with its own rules for changes.
    const scope = await this.scopeOf(u.origin);
    if (scope) {
      if (!req.document && req.from !== u.origin)
        return "A page from another site may not reach your apps.";
      const method = (req.method ?? "GET").toUpperCase();
      // A page's live-update connection (SignalR, as the *arr apps use) changes nothing.
      const connection = /\/signalr\/|\/negotiate$/i.test(u.pathname);
      if (!["GET", "HEAD", "OPTIONS"].includes(method) && !connection) {
        if (this.looking)
          return `You asked Ember only to look, so nothing is sent to ${scope.name}.`;
        if (scope.protected)
          return `${scope.name} is a protected system: it is never changed from the browser. Changes there go through a protected plan.`;
        const no = await this.opts.mayChange?.(scope);
        if (no) return this.opts.stage ? { hold: scope } : no;
      }
      return undefined;
    }
    if (this.opts.allowLocal) return undefined;
    let cached = this.hosts.get(host);
    if (!cached) {
      cached = (async () => {
        if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local"))
          return PRIVATE_REFUSAL;
        const ips = isIP(host)
          ? [host]
          : await (this.opts.resolve ?? resolveAll)(host).catch(() => [] as string[]);
        if (!ips.length) return `${host} could not be found.`;
        return ips.some(isPrivateAddress) ? PRIVATE_REFUSAL : undefined;
      })();
      this.hosts.set(host, cached);
      if (this.hosts.size > 500) this.hosts.delete(this.hosts.keys().next().value!);
    }
    return cached;
  }

  /** The owner's app at this origin (looked up for half a minute at a time). */
  private scopeOf(origin: string): Promise<ServiceScope | undefined> {
    if (!this.opts.scope) return Promise.resolve(undefined);
    const hit = this.scopes.get(origin);
    if (hit && Date.now() - hit.at < 30_000) return hit.scope;
    const scope = this.opts.scope(origin).catch(() => undefined);
    this.scopes.set(origin, { at: Date.now(), scope });
    return scope;
  }

  /**
   * Before opening one of the owner's apps: signed in server side, once per session, when the
   * owner allowed it. Only the session reaches the browser, for that app's origin.
   */
  private async session(url: string) {
    const o = originOf(url);
    if (!o || this.signed.has(o)) return;
    const scope = await this.scopeOf(o);
    if (!scope || !this.opts.signIn) return;
    try {
      const material = await this.opts.signIn(scope);
      if (material.cookies.length)
        await this.send("Storage.setCookies", {
          cookies: material.cookies.map((c) => ({
            name: c.name,
            value: c.value,
            url: o,
            path: c.path || "/",
            httpOnly: c.httpOnly ?? true,
            secure: c.secure ?? o.startsWith("https:"),
          })),
        });
      this.signed.set(o, { scope, state: "signed-in", how: material.how, material });
    } catch (error) {
      this.signed.set(o, {
        scope,
        state: "not-signed-in",
        how: error instanceof Error ? error.message : String(error),
      });
    }
    this.opts.onChange?.();
  }

  /** The secrets to hide on this page (its app's, when signed in), never returned. */
  private async secretsFor(url: string): Promise<string[]> {
    const o = originOf(url);
    const v = o ? this.signed.get(o) : undefined;
    if (!v || !this.opts.secrets) return [];
    const own = (await this.opts.secrets(v.scope).catch(() => [] as string[])).filter(
      (x) => x.length >= 6,
    );
    const session = (v.material?.cookies ?? []).map((c) => c.value).filter((x) => x.length >= 6);
    return [...own, ...session];
  }

  private async allowed(url: string): Promise<string> {
    const full = /^[a-z]+:/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
    const verdict = await this.refusal(full, { document: true });
    const why = typeof verdict === "object" ? undefined : verdict;
    if (why) throw new BrowserError(why);
    return full;
  }

  private async navigate(tab: Tab, url: string) {
    const loaded = this.waitLoad(tab, LOAD_MS);
    const r = (await this.send("Page.navigate", { url }, tab)) as { errorText?: string };
    if (r.errorText) {
      const blocked =
        this.blocked && this.blocked.url === url.slice(0, 200) ? this.blocked.why : "";
      throw new BrowserError(blocked || `The page did not open (${r.errorText}).`);
    }
    await loaded;
    await this.refresh(tab);
  }

  private waitLoad(tab: Tab, ms: number) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.loads.delete(tab.id);
        resolve();
      }, ms);
      this.loads.set(tab.id, () => {
        clearTimeout(t);
        this.loads.delete(tab.id);
        resolve();
      });
    });
  }

  private async refresh(tab: Tab) {
    try {
      const r = (await this.eval(tab, "[location.href, document.title]")) as [string, string];
      tab.url = r[0];
      tab.title = r[1].slice(0, 200);
    } catch {
      // the page is between documents
    }
    this.opts.onChange?.();
  }

  private async box(tab: Tab, ref: string) {
    const b = (await this.eval(
      tab,
      `(() => { const e = document.querySelector('[data-ember-ref="${ref}"]'); if (!e) return null;
        e.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }); const r = e.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    )) as { x: number; y: number } | null;
    if (!b) throw new BrowserError("That control is no longer on the page. Read the page again.");
    return b;
  }

  private point(tab: Tab, at: { x: number; y: number }, kind: "click" | "type") {
    this.pointer = {
      tab: tab.id,
      x: Math.round(at.x),
      y: Math.round(at.y),
      kind,
      at: new Date().toISOString(),
    };
    this.opts.onChange?.();
  }

  private page(tab: Tab): BrowserPage {
    return { tab: tab.id, url: tab.url, title: tab.title };
  }

  private tab(id?: string): Tab {
    const t = this.tabs.get(id ?? this.emberTab ?? "");
    if (!t || !this.ws) throw new BrowserError("Ember's browser has no page open. Open one first.");
    this.touch();
    return t;
  }

  private note(label: string, by: "ember" | "owner") {
    this.last = { label: label.slice(0, 160), by, at: new Date().toISOString() };
    this.opts.onChange?.();
  }

  /** Closes itself after ten minutes with nothing done and nobody watching. */
  private touch() {
    clearTimeout(this.idle);
    const idle = this.opts.idleMs ?? IDLE_MS;
    this.idleAt = Date.now() + idle;
    this.idle = setTimeout(() => {
      const watched = [...this.tabs.values()].some((t) => t.viewers.size);
      if (watched || this.busy()) this.touch();
      else void this.close();
    }, idle);
    this.idle.unref?.();
  }

  private async eval(tab: Tab, expression: string): Promise<unknown> {
    const r = (await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      tab,
    )) as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (r.exceptionDetails) throw new BrowserError("The page did not answer.");
    return r.result?.value;
  }

  private send(method: string, params: Json = {}, tab?: Tab): Promise<Json> {
    const ws = this.ws;
    if (!ws) return Promise.reject(new BrowserError("Ember's browser is not running."));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (this.waiting.delete(id))
          reject(new BrowserError(`The browser did not answer (${method}).`));
      }, 30_000);
      this.waiting.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
      ws.send(JSON.stringify({ id, method, params, ...(tab ? { sessionId: tab.session } : {}) }));
    });
  }
}

const PRIVATE_REFUSAL =
  "That address is on your own network but is not one of your systems in Hearth. Add it to Hearth (Add a system) and Ember can open it.";

/** "https://radarr.lan:7878" from any address, or nothing. */
export function originOf(url: string): string | undefined {
  try {
    const o = new URL(url).origin;
    return o === "null" ? undefined : o;
  } catch {
    return undefined;
  }
}

/** Replaces every secret in a text (never shows which). */
export function scrubSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const x of secrets) if (x && out.includes(x)) out = out.split(x).join("[hidden]");
  return out;
}

function safeName(name: string): string {
  const n = [...name]
    .map((c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? "_" : c))
    .join("")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return n || "download";
}

function writeFrame(res: ServerResponse, frame: Buffer) {
  res.write(`Content-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
  res.write(frame);
  // Closed by the next boundary at once: a still page paints only one frame.
  res.write("\r\n--frame\r\n");
}

async function resolveAll(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map((a) => a.address);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}
