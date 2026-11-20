import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createSocket } from "node:dgram";
import { hostname, networkInterfaces } from "node:os";
import path from "node:path";
import { findBrowser, hasScreen } from "../browser/manager";
import { youtubeChannels, type YoutubeChannel } from "./youtube-music";

/**
 * Setting up Music Assistant from Hearth (11-05: "she needs to put up a browser for me to see
 * to sign in"). Three steps, each on screen, none typed by an AI:
 *
 * 1. Music Assistant's own sign-in page opens in a window. When the owner signs in there, Music
 *    Assistant sends its session back to Hearth (its standard login redirect, `code`), and Hearth
 *    keeps it in memory for this setup only. Hearth then finishes Music Assistant's first-run setup.
 * 2. Home Assistant's Music Assistant integration is added with that session (Home Assistant swaps
 *    it for its own long-lived token, which Home Assistant keeps).
 * 3. YouTube Music: Google refuses sign-ins from any browser under remote control, which is what
 *    Ember's Browser is. So Hearth opens an ordinary Chrome window on this machine's screen, with a
 *    profile of its own made just for this (never the owner's own browser profile), and nothing
 *    attached to it. The owner signs in to YouTube Music there and presses Done. Only then Hearth
 *    closes that window, reads the YouTube sign-in from that profile, hands it straight to Music
 *    Assistant's YouTube Music setup, and deletes the profile.
 *
 * The session and the YouTube sign-in never leave the backend: not to the page, the AI, logs,
 * audit entries or errors.
 */

type Fetch = typeof fetch;

export class MusicLinkError extends Error {}

interface Pending {
  state: string;
  address: string;
  /** Music Assistant's session for this setup (from its sign-in). Never sent anywhere else. */
  token?: string;
  createdAt: number;
  youtube?: { proc?: ChildProcess; profile: string };
  /** The YouTube sign-in, between Done and picking the channel (memory only). */
  cookie?: string;
}

export interface MusicLinkStatus {
  state: string;
  address: string;
  signedIn: boolean;
  youtubeOpen: boolean;
}

/** How long a setup stays open (the sign-in pages and the YouTube window). */
const TTL = 30 * 60_000;
const YTM = "https://music.youtube.com";

export const cleanAddress = (raw: string): string => {
  const t = raw.trim();
  const hadScheme = /^https?:\/\//i.test(t);
  const u = new URL(hadScheme ? t : `http://${t}`);
  // A bare host gets Music Assistant's own port.
  if (!hadScheme && !u.port) u.port = "8095";
  return u.origin;
};

/** This machine's home-network address, the one on the same network as `near` when there is one. */
export function lanAddressFor(near: string): string | undefined {
  const mine = Object.values(networkInterfaces())
    .flat()
    .filter((a): a is NonNullable<typeof a> => Boolean(a && a.family === "IPv4" && !a.internal))
    .map((a) => a.address)
    .filter((a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
  if (mine.includes(near)) return near;
  const prefix = near.split(".").slice(0, 3).join(".");
  return mine.find((a) => a.startsWith(`${prefix}.`)) ?? mine[0];
}

/** The address this machine uses to reach `host` (no packet is sent; the route decides). */
export function sourceAddressToward(host: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const sock = createSocket(host.includes(":") ? "udp6" : "udp4");
    const done = (v?: string) => {
      try {
        sock.close();
      } catch {
        // already closed
      }
      resolve(v);
    };
    sock.once("error", () => done(undefined));
    try {
      sock.connect(9, host, () => {
        try {
          done(sock.address().address);
        } catch {
          done(undefined);
        }
      });
    } catch {
      done(undefined);
    }
  });
}

/**
 * The address Home Assistant should use. This machine's own names (localhost, 127.0.0.1, its
 * host name, .local names) mean something else inside Home Assistant's container, so they become
 * the address this machine uses to reach Home Assistant, keeping the port.
 */
export async function reachableAddress(
  address: string,
  homeAssistant: string,
  source: (host: string) => Promise<string | undefined> = sourceAddressToward,
): Promise<string> {
  const u = new URL(address);
  const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local =
    h === "localhost" ||
    h === "::1" ||
    /^127\./.test(h) ||
    h === hostname().toLowerCase() ||
    h.endsWith(".local");
  if (!local) return u.origin;
  let haHost: string;
  try {
    haHost = new URL(homeAssistant).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return u.origin;
  }
  const ip = await source(haHost);
  if (!ip || /^127\.|^::1$/.test(ip)) return u.origin;
  u.hostname = ip.includes(":") ? `[${ip}]` : ip;
  return u.origin;
}

/** One Music Assistant API command (its JSON-RPC endpoint), with this setup's session. */
export async function maCommand<T = unknown>(
  fetchImpl: Fetch,
  address: string,
  token: string,
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetchImpl(`${address}/api`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ message_id: randomBytes(6).toString("hex"), command, args }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok)
    throw new MusicLinkError(
      `Music Assistant: ${(text.trim() || `answered ${res.status}`).slice(0, 200)}`,
    );
  // The answer is the command's result itself.
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

/** The YouTube sign-in as one Cookie header, from the cookies of a Chrome profile. */
export function youtubeCookieHeader(cookies: { name: string; value: string; domain: string }[]) {
  const ours = cookies.filter((c) => /(^|\.)youtube\.com$/i.test(c.domain.replace(/^\./, "")));
  const seen = new Set<string>();
  const pairs: string[] = [];
  for (const c of ours) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    pairs.push(`${c.name}=${c.value}`);
  }
  const signedIn = ours.some((c) => /^(__Secure-3PAPISID|SAPISID)$/.test(c.name));
  return { header: pairs.join("; "), signedIn };
}

export interface ChromeRunner {
  /** Opens an ordinary window (nothing attached) with this profile at this address. */
  openWindow(profile: string, url: string): ChildProcess;
  /** Reads every cookie of the profile (Chrome started hidden for a moment, then stopped). */
  readCookies(profile: string): Promise<{ name: string; value: string; domain: string }[]>;
}

const CHROME_FLAGS = (profile: string) => [
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--password-store=basic",
];

/** The real Chrome on this machine. */
export const realChrome: ChromeRunner = {
  openWindow(profile, url) {
    const exe = findBrowser();
    if (!exe) throw new MusicLinkError("No Chrome, Edge or Chromium is installed on this machine.");
    if (!hasScreen())
      throw new MusicLinkError(
        "This machine has no screen for a window (Hearth runs here without a desktop).",
      );
    const proc = spawn(exe, [...CHROME_FLAGS(profile), "--new-window", url], {
      stdio: "ignore",
      detached: false,
    });
    return proc;
  },
  async readCookies(profile) {
    const exe = findBrowser();
    if (!exe) throw new MusicLinkError("No Chrome, Edge or Chromium is installed on this machine.");
    const proc = spawn(
      exe,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
        ...CHROME_FLAGS(profile),
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let err = "";
        const t = setTimeout(() => reject(new MusicLinkError("Chrome did not start.")), 20_000);
        proc.stderr!.on("data", (c: Buffer) => {
          err += c.toString();
          const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
          if (m) {
            clearTimeout(t);
            resolve(m[1]!);
          }
        });
        proc.once("exit", () => {
          clearTimeout(t);
          reject(new MusicLinkError("Chrome stopped before Hearth could read the sign-in."));
        });
      });
      const ws = new WebSocket(url);
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", () => reject(new MusicLinkError("No connection to Chrome.")), {
          once: true,
        });
      });
      const cookies = await new Promise<{ name: string; value: string; domain: string }[]>(
        (resolve, reject) => {
          const t = setTimeout(() => reject(new MusicLinkError("Chrome did not answer.")), 10_000);
          ws.addEventListener("message", (ev) => {
            const m = JSON.parse(String(ev.data)) as {
              id?: number;
              result?: { cookies?: { name: string; value: string; domain: string }[] };
            };
            if (m.id === 1) {
              clearTimeout(t);
              resolve(m.result?.cookies ?? []);
            }
          });
          ws.send(JSON.stringify({ id: 1, method: "Storage.getCookies", params: {} }));
        },
      );
      ws.close();
      return cookies;
    } finally {
      proc.kill();
    }
  },
};

export class MusicAssistantLink {
  private pending = new Map<string, Pending>();

  constructor(
    private readonly profilesDir: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly chrome: ChromeRunner = realChrome,
  ) {}

  private get(state: string): Pending {
    this.sweep();
    const p = this.pending.get(state);
    if (!p) throw new MusicLinkError("This setup has ended. Start again.");
    return p;
  }

  private sweep() {
    const now = Date.now();
    for (const [k, p] of this.pending)
      if (now - p.createdAt > TTL) {
        this.endYoutube(p);
        this.pending.delete(k);
      }
  }

  /**
   * Starts a setup: checks the address is a Music Assistant, and gives the address of its own
   * sign-in page, which sends its session back to `backUrl` (this Hearth).
   */
  async start(rawAddress: string, backUrlFor: string | ((maHost: string) => string)) {
    let address: string;
    try {
      address = cleanAddress(rawAddress);
    } catch {
      throw new MusicLinkError("That is not an address.");
    }
    const info = await this.fetchImpl(`${address}/info`, { signal: AbortSignal.timeout(8_000) })
      .then((r) => (r.ok ? r.json() : undefined))
      .catch(() => undefined);
    if (!info || typeof info !== "object" || !("server_version" in info))
      throw new MusicLinkError(`No Music Assistant answers at ${address}.`);
    const backUrl =
      typeof backUrlFor === "string" ? backUrlFor : backUrlFor(new URL(address).hostname);
    const state = randomBytes(18).toString("base64url");
    this.pending.set(state, { state, address, createdAt: Date.now() });
    const back = `${backUrl}?state=${encodeURIComponent(state)}`;
    const loginUrl = `${address}/login?${new URLSearchParams({ return_url: back, device_name: "Hearth" })}`;
    return {
      state,
      address,
      loginUrl,
      version: String((info as { server_version: unknown }).server_version),
    };
  }

  /** Music Assistant's sign-in sent its session back. */
  back(state: string, code: string) {
    const p = this.get(state);
    if (!code || code.length < 10) throw new MusicLinkError("Music Assistant sent no sign-in.");
    p.token = code;
  }

  status(state: string): MusicLinkStatus {
    const p = this.get(state);
    return {
      state,
      address: p.address,
      signedIn: Boolean(p.token),
      youtubeOpen: Boolean(p.youtube),
    };
  }

  private tokenOf(p: Pending) {
    if (!p.token) throw new MusicLinkError("Sign in to Music Assistant first.");
    return p.token;
  }

  /** Finishes Music Assistant's first-run setup when it is not finished yet. */
  async finishSetup(state: string) {
    const p = this.get(state);
    const token = this.tokenOf(p);
    const info = (await this.fetchImpl(`${p.address}/info`, { signal: AbortSignal.timeout(8_000) })
      .then((r) => r.json())
      .catch(() => ({}))) as { onboard_done?: boolean };
    if (info.onboard_done === false)
      await maCommand(this.fetchImpl, p.address, token, "config/onboard_complete");
    return { onboarded: true };
  }

  /** For Home Assistant's integration: the address and this setup's session (backend only). */
  forHomeAssistant(state: string) {
    const p = this.get(state);
    return { address: p.address, token: this.tokenOf(p) };
  }

  /** Whether YouTube Music is already added in this Music Assistant. */
  async youtubeAdded(state: string) {
    const p = this.get(state);
    const list = await maCommand<{ domain?: string }[]>(
      this.fetchImpl,
      p.address,
      this.tokenOf(p),
      "config/providers",
      { provider_domain: "ytmusic" },
    ).catch(() => []);
    return Array.isArray(list) && list.length > 0;
  }

  /** Opens an ordinary Chrome window at YouTube Music with a profile made for this setup. */
  openYoutube(state: string) {
    const p = this.get(state);
    this.tokenOf(p);
    this.endYoutube(p);
    const profile = path.join(this.profilesDir, `youtube-${randomBytes(6).toString("hex")}`);
    mkdirSync(profile, { recursive: true });
    const proc = this.chrome.openWindow(profile, YTM);
    p.youtube = { proc, profile };
    return { opened: true };
  }

  /**
   * The owner pressed Done: closes the window and reads the YouTube sign-in from its profile.
   * Not signed in yet: the window opens again. Signed in: the channels it can play as (the
   * person's own and any brand channels), for the owner to pick.
   */
  async youtubeRead(
    state: string,
  ): Promise<
    { signedIn: false; message: string } | { signedIn: true; channels: YoutubeChannel[] }
  > {
    const p = this.get(state);
    this.tokenOf(p);
    if (!p.youtube) throw new MusicLinkError("Open the YouTube window first.");
    const yt = p.youtube;
    yt.proc?.kill();
    // Chrome writes its cookies when it closes.
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const got = youtubeCookieHeader(await this.chrome.readCookies(yt.profile));
      if (!got.signedIn) {
        p.youtube = { proc: this.chrome.openWindow(yt.profile, YTM), profile: yt.profile };
        return {
          signedIn: false,
          message:
            "That window wasn't signed in to YouTube Music yet. It's open again: sign in, then press Done.",
        };
      }
      p.cookie = got.header;
    } catch (error) {
      this.endYoutube(p);
      throw error;
    }
    // The profile has done its job: the sign-in is in memory for this setup only.
    this.endYoutube(p);
    const channels = await youtubeChannels(this.fetchImpl, p.cookie).catch(() => []);
    // Couldn't list them: the person's own channel still works.
    return {
      signedIn: true,
      channels: channels.length ? channels : [{ name: "Your own channel" }],
    };
  }

  /**
   * Adds YouTube Music in Music Assistant as the chosen channel, in place of any YouTube Music
   * already there (one account at a time, so the library isn't two accounts mixed). Gives the
   * sign-in back so Hearth can keep it in Secure Vault for the home rows.
   */
  async youtubeDone(
    state: string,
    channel: { id?: string; name: string },
  ): Promise<
    { added: false; message: string } | { added: true; cookie: string; channel?: string }
  > {
    const p = this.get(state);
    const token = this.tokenOf(p);
    const cookie = p.cookie;
    if (!cookie) throw new MusicLinkError("Sign in to YouTube Music first.");
    if (channel.id && !/^\d{10,30}$/.test(channel.id))
      throw new MusicLinkError("That isn't one of the channels YouTube listed.");
    const before = await maCommand<{ instance_id?: string }[]>(
      this.fetchImpl,
      p.address,
      token,
      "config/providers",
      { provider_domain: "ytmusic" },
    ).catch(() => []);
    const flow = await maCommand<{ flow_id?: string }>(
      this.fetchImpl,
      p.address,
      token,
      "config/providers/setup",
      { provider_domain: "ytmusic" },
    );
    if (!flow?.flow_id)
      throw new MusicLinkError("Music Assistant did not start YouTube Music's setup.");
    const step = await maCommand<{ type?: string; errors?: Record<string, string> | null }>(
      this.fetchImpl,
      p.address,
      token,
      "config/flows/submit",
      {
        flow_id: flow.flow_id,
        values: {
          // Music Assistant plays as a brand channel when this is its page id.
          username: channel.id ?? channel.name.slice(0, 200),
          cookie,
          // Music Assistant's own default: the token helper on this machine.
          po_token_server_url: "http://127.0.0.1:4416",
        },
      },
    );
    const err = step?.errors ? Object.values(step.errors)[0] : undefined;
    if (err || step?.type !== "finish") {
      await maCommand(this.fetchImpl, p.address, token, "config/flows/abort", {
        flow_id: flow.flow_id,
      }).catch(() => undefined);
      return { added: false, message: plainYoutubeError(err) };
    }
    // The new one works: the old ones go (their library with them; the new one syncs its own).
    for (const old of Array.isArray(before) ? before : [])
      if (old.instance_id)
        await maCommand(this.fetchImpl, p.address, token, "config/providers/remove", {
          instance_id: old.instance_id,
        }).catch(() => undefined);
    p.cookie = undefined;
    return { added: true, cookie, ...(channel.id ? { channel: channel.id } : {}) };
  }

  /**
   * A setup with the Music Assistant key Hearth already keeps, so the owner goes straight to
   * YouTube Music (Change YouTube account) without signing in to Music Assistant again.
   */
  startWithKey(address: string, key: string) {
    const state = randomBytes(18).toString("base64url");
    this.pending.set(state, {
      state,
      address: cleanAddress(address),
      createdAt: Date.now(),
      token: key,
    });
    return { state, address: cleanAddress(address) };
  }

  /** Ends the setup: closes the YouTube window and deletes its profile, forgets the session. */
  end(state: string) {
    const p = this.pending.get(state);
    if (!p) return;
    this.endYoutube(p);
    this.pending.delete(state);
  }

  private endYoutube(p: Pending) {
    if (!p.youtube) return;
    p.youtube.proc?.kill();
    const dir = p.youtube.profile;
    p.youtube = undefined;
    setTimeout(() => rmSync(dir, { recursive: true, force: true }), 3000).unref?.();
  }
}

/** Music Assistant's YouTube Music setup errors, in plain words. */
export function plainYoutubeError(code: string | undefined): string {
  const c = String(code ?? "").toLowerCase();
  if (/premium/.test(c))
    return "YouTube said this account doesn't have YouTube Music Premium. Music Assistant only plays YouTube Music with Premium.";
  if (/po_token|token_server/.test(c))
    return "Music Assistant couldn't reach its YouTube token helper. Ask Ember to check the yt-po-token container.";
  if (/cookie|login|auth|expired/.test(c))
    return "YouTube didn't accept the sign-in. Press Open YouTube again, sign in, then Done.";
  return `Music Assistant couldn't add YouTube Music${c ? ` (${c.replace(/_/g, " ")})` : ""}.`;
}
