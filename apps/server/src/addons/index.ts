import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PremiumFeature } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import type { z as Zod } from "zod";
import type { AgentContext } from "../agent/tools";
import type { CustomPanels } from "../panels/service";

/**
 * Add-ons (11-14, the Premium split): the public core is complete on its own, and the Premium
 * extras ship as a separate, closed-source package that plugs in here. An add-on is a folder
 * with a package.json naming `"hearth": { "addon": "<entry file>" }`; its entry exports `addon`.
 *
 * The core never depends on an add-on: with none installed every Premium spot shows a Premium
 * card and everything else works. An add-on that fails to load is reported and skipped, never
 * fatal. This contract is versioned (ADDON_API): an add-on built for another version is not
 * loaded, with a plain reason, until a matching one is installed.
 */
export const ADDON_API = 1;

export interface AddonHost {
  /** The contract version this core speaks (ADDON_API). */
  api: number;
  /** This Hearth's version. */
  coreVersion: string;
  /** Hearth's web server: an add-on adds its routes here (under /api/addons/<name>/ by convention). */
  app: FastifyInstance;
  db: DbHandle;
  /** Whether this Hearth's licence gives a Premium feature now. */
  has(feature: PremiumFeature): Promise<boolean>;
  /** Throws the core's own "needs Premium" error (HTTP 402) when it does not. */
  require(feature: PremiumFeature, what: string): Promise<void>;
  /**
   * Ember's tools: called for every agent session (Claude Code, Codex and Ollama all reach
   * Ember's tools through the one MCP server, so a tool added here reaches every agent).
   */
  tools(add: (server: McpServer, ctx: AddonToolContext) => void): void;
  /** Lines for Ember's instructions, read each turn (absent or empty: nothing added). */
  instructions(add: () => Promise<string | undefined> | string | undefined): void;
  log: { info(msg: string): void; warn(msg: string): void };
  /** Throws the core's "sign in" error (403) unless the request is from a signed-in owner. */
  signedIn(request: FastifyRequest): void;
  /** The core's plain-words "bad request" error (400), for an add-on's own errors. */
  badRequest(message: string): Error;
  /** Hearth's settings store (an add-on keeps its own keys, prefixed with its name). */
  settings: {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    del(key: string): Promise<void>;
  };
  /** The apps Hearth watches that are in use (id, name, which app, sample data or real). */
  services(): Promise<
    { id: string; name: string; image: string | null; app?: string; demo: boolean }[]
  >;
  /** Reads from an app with its Secure Vault credential, as the core's own panels do. */
  apps: {
    plexGet<T>(serviceId: string, path: string, purpose: string): Promise<T>;
    tautulliGet<T>(
      serviceId: string,
      cmd: string,
      params: Record<string, string | number>,
      purpose: string,
    ): Promise<T>;
  };
  /** Ember without tools, for short wording work (the owner's chosen AI). */
  ai: { suggest(system: string, prompt: string): Promise<string> };
  /**
   * The custom panel store and its read-only runner (Panel Builder's engine). It refuses anything
   * custom without the Panel Builder licence; the add-on adds the owner's routes and Ember's tool.
   */
  panels: CustomPanels;
  /** Show & Tell's hooks into Ember's turn and tools (the Premium package hands them over). */
  show(hooks: import("../show/hooks").ShowHooks): void;
  /**
   * Hearth Connected's toolkit (the PC store, live links, sign-in checks, Hearth's socket server),
   * and Ollama's account setup and the PC hello, for passing Ollama to joined PCs.
   */
  connected: import("../pcs/routes").ConnectedKit & {
    ollama?: {
      config(): import("../engine/ollama").OllamaConfig | null;
      localOnly(url: string): boolean;
      onChange(fn: () => void): void;
    };
    onPcHello(fn: (pcId: string) => void): void;
  };
  /** The core's zod, so an add-on's tool and route schemas are the same kind as Hearth's. */
  z: typeof Zod;
  /** A line in Hearth's audit log, as the owner (the add-on's own changes, plainly worded). */
  audit(entry: { action: string; target: string; detail?: Record<string, unknown> }): Promise<void>;
}

/** What an add-on's Ember tool sees of the session: the steps it took and what it read. */
export interface AddonToolContext {
  /** Plain notes of what was changed, shown with the answer. */
  steps: string[];
  /** The answer's live progress (its steps on screen), when it is a conversation. */
  progress?: AgentContext["progress"];
  /** Something Ember read, cited in the answer like the core's own tools. */
  consult(e: { label: string; ref: string; kind: "live" | "record" | "memory" }): void;
}

export interface HearthAddon {
  name: string;
  version: string;
  /** The ADDON_API it was built for. */
  api: number;
  /** The Premium features it provides (shown in Settings > Premium). */
  features: PremiumFeature[];
  register(host: AddonHost): void | Promise<void>;
}

export interface LoadedAddon {
  name: string;
  version: string;
  features: PremiumFeature[];
  /** Its web part, served at /addons/<name>/ when it has one. */
  web?: string;
  /** Its screens' own styles (web/index.css), loaded beside them. */
  css?: boolean;
}

export interface SkippedAddon {
  folder: string;
  why: string;
}

/** What the core keeps of its add-ons, for its own hooks to call. */
export class Addons {
  readonly loaded: LoadedAddon[] = [];
  readonly skipped: SkippedAddon[] = [];
  private readonly toolFns: ((server: McpServer, ctx: AddonToolContext) => void)[] = [];
  private readonly instructionFns: (() => Promise<string | undefined> | string | undefined)[] = [];
  /** Folders of loaded add-ons' web parts, by add-on name. */
  readonly webDirs = new Map<string, string>();

  /** Ember's tools from every add-on, added to one agent session's server. */
  addTools(server: McpServer, ctx: AgentContext): void {
    const tc: AddonToolContext = {
      steps: ctx.steps,
      ...(ctx.progress ? { progress: ctx.progress } : {}),
      consult: (e) => {
        ctx.consulted ??= [];
        if (ctx.consulted.some((x) => x.ref === e.ref && x.label === e.label)) return;
        ctx.consulted.push({ id: `C${ctx.consulted.length + 1}`, ...e });
      },
    };
    for (const add of this.toolFns) {
      try {
        add(server, tc);
      } catch {
        // One add-on's broken tool never takes Ember's other tools down.
      }
    }
  }

  /** Every add-on's lines for Ember's instructions this turn. */
  async instructions(): Promise<string[]> {
    const out: string[] = [];
    for (const read of this.instructionFns) {
      try {
        const line = await read();
        if (line?.trim()) out.push(line.trim());
      } catch {
        // Skipped, as above.
      }
    }
    return out;
  }

  /**
   * Loads every add-on in `dir` (one folder each). Never throws: what could not load is in
   * `skipped` with the reason.
   */
  async load(
    dir: string | undefined,
    host: Omit<AddonHost, "tools" | "instructions" | "api">,
  ): Promise<void> {
    if (!dir || !existsSync(dir)) return;
    for (const folder of readdirSync(dir).sort()) {
      // Hidden folders are Hearth's own: the copy kept from before the last Premium update, and
      // downloads being unpacked. Loading the kept copy too made the new one clash with it,
      // which read as a broken package, reinstalled, reloaded, again and again (11-23).
      if (folder.startsWith(".")) continue;
      const root = path.join(dir, folder);
      try {
        if (!statSync(root).isDirectory()) continue;
        const pkgFile = path.join(root, "package.json");
        if (!existsSync(pkgFile)) continue;
        const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as {
          hearth?: { addon?: string; web?: string };
        };
        const entry = pkg.hearth?.addon;
        if (!entry) continue;
        const file = path.resolve(root, entry);
        if (!file.startsWith(root + path.sep)) {
          this.skipped.push({ folder, why: "Its entry file is outside its folder." });
          continue;
        }
        const mod = (await import(pathToFileURL(file).href)) as { addon?: HearthAddon };
        const addon = mod.addon;
        if (!addon || typeof addon.register !== "function") {
          this.skipped.push({ folder, why: "It does not export an add-on." });
          continue;
        }
        if (addon.api !== ADDON_API) {
          this.skipped.push({
            folder,
            why: `It was built for add-on version ${addon.api}; this Hearth speaks version ${ADDON_API}. Update it to match this Hearth.`,
          });
          continue;
        }
        await addon.register({
          ...host,
          api: ADDON_API,
          tools: (add) => void this.toolFns.push(add),
          instructions: (add) => void this.instructionFns.push(add),
        });
        const web = pkg.hearth?.web ? path.resolve(root, pkg.hearth.web) : undefined;
        if (web && web.startsWith(root + path.sep) && existsSync(web))
          this.webDirs.set(addon.name, web);
        this.loaded.push({
          name: addon.name,
          version: addon.version,
          features: [...addon.features],
          ...(this.webDirs.has(addon.name) ? { web: `/addons/${addon.name}/` } : {}),
          ...(web && this.webDirs.has(addon.name) && existsSync(path.join(web, "index.css"))
            ? { css: true }
            : {}),
        });
        host.log.info(`Add-on ${addon.name} ${addon.version} loaded.`);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        this.skipped.push({ folder, why: `It failed to load: ${why}` });
        host.log.warn(`Add-on in ${folder} failed to load: ${why}`);
      }
    }
  }
}
