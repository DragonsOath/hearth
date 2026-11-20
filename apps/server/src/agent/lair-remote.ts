import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Remotes, remoteTitle, type Prompt, type RemoteHub } from "../engine/remote";
import { DEFAULT_ALLOWED_TOOLS } from "../engine/queue";
import { hearthGuide } from "../engine/runners";
import type { Terminals } from "../engine/terminal";

/**
 * Remote Control (/rc) in the Lair (11-04: "remote access works in the Lair, the same as the
 * War Room"). A Lair conversation is answered by one Claude Code run per message; /rc opens it
 * instead as one live Claude Code session that also shows in the Claude app and at claude.ai/code,
 * listed as "Hearth • <PC> • Lair • <Main or the project>". The session gets what a Lair answer
 * gets: Ember's instructions, the conversation so far, Hearth's tools under the same approvals,
 * and the owner's Full access setting. Both sides are mirrored into the Lair conversation, so when
 * /rc is turned off the next message carries on with everything that was said.
 */

export const RC_COMMAND = /^\/(?:rc|remote-control)(?:\s+(\w+))?\s*$/i;

/** What a Lair session starts with (made by the agent service for each start). */
export interface LairRemoteSetup {
  /** Ember's instructions, with the conversation so far. */
  system: string;
  /** Hearth's tools: the MCP address and a key that lives only as long as the session. */
  mcpUrl: string;
  key: string;
  /** Keeps the key alive while the session runs (it would end after 20 minutes otherwise). */
  renew: () => Promise<void>;
  release: () => Promise<void>;
  full: boolean;
  /** Where Claude Code works: the Lair's folder. */
  cwd: string;
  /** "Main", or the conversation's project. */
  name: string;
}

export interface LairRemoteDeps {
  terminals: () => Terminals | undefined;
  binary: () => string | undefined;
  pcName: () => string;
  setup: (conversationId: string) => Promise<LairRemoteSetup>;
  /** Writes one message into a Lair conversation. */
  say: (
    conversationId: string,
    role: "you" | "agent" | "note",
    text: string,
    from?: string,
  ) => Promise<void>;
  setting: <T>(key: string, fallback: T) => Promise<T>;
  setSetting: (key: string, value: unknown) => Promise<void>;
  /** Tests: arguments before Claude Code's own, and where its transcripts are. */
  launch?: string[];
  transcripts?: string;
}

const ACTIVE = "lair_rc_active";
const sessionKey = (id: string) => `lair_rc_session:${id}`;
const slugOf = (id: string) => `lair-${id}`;
const idOf = (slug: string) => slug.replace(/^lair-/, "");
const RENEW_MS = 10 * 60_000;

interface Live {
  cleanup: () => Promise<void>;
  ask?: { id: number; prompt: Prompt };
}

export class LairRemotes {
  private remotes?: Remotes;
  private readonly live = new Map<string, Live>();
  /** Turned off by the owner: the reply already says so, no second note when it ends. */
  private readonly quiet = new Set<string>();
  private asks = 0;

  constructor(private readonly deps: LairRemoteDeps) {}

  private hub(): RemoteHub {
    const say = (slug: string, role: "you" | "agent" | "note", text: string, from?: string) =>
      void this.deps.say(idOf(slug), role, text, from).catch(() => undefined);
    return {
      message: (slug, role, text, meta) => {
        // The bar over the message box links to the session: here, plain words name it.
        const r = this.remotes?.get(slug);
        if (r && text.startsWith("Remote Control is on for"))
          return say(
            slug,
            "note",
            `Remote Control is on. In the Claude app, open Code and pick ${r.title}. Keep typing here too: both sides see the same conversation. Type /rc again to turn it off.`,
            "Remote Control",
          );
        say(slug, role === "ember" ? "agent" : role === "you" ? "you" : "note", text, meta);
      },
      ask: (slug, p) => {
        const id = ++this.asks;
        const l = this.live.get(idOf(slug));
        if (l) l.ask = { id, prompt: p };
        say(
          slug,
          "note",
          [
            `Claude Code is asking: ${p.title}`,
            ...p.details.map((d) => `> ${d}`),
            p.question,
            ...p.options.map((o) => `${o.key}. ${o.label}`),
            // The one-time warning comes before the session reaches the Claude app, so only
            // Hearth can answer it (11-08: he waited in the app and nothing came).
            p.enter
              ? "Answer here: Claude Code waits on this before the Claude app can connect."
              : "Answer here, or in the Claude app.",
          ].join("\n"),
          "Remote Control",
        );
        return id;
      },
      askClosed: (id, answered) => {
        for (const [conv, l] of this.live)
          if (l.ask?.id === id) {
            l.ask = undefined;
            say(slugOf(conv), "note", `Answered: ${answered}.`, "Remote Control");
          }
      },
      changed: () => undefined,
      saveSession: (slug, sid) => void this.deps.setSetting(sessionKey(idOf(slug)), sid),
      active: (slug, on) =>
        void (async () => {
          const now = new Set(await this.deps.setting<string[]>(ACTIVE, []));
          if (on) now.add(idOf(slug));
          else now.delete(idOf(slug));
          await this.deps.setSetting(ACTIVE, [...now].sort());
        })(),
      ended: (slug) => {
        const id = idOf(slug);
        const l = this.live.get(id);
        this.live.delete(id);
        void l?.cleanup();
        if (this.quiet.delete(id)) return;
        say(
          slug,
          "note",
          "Remote Control ended. Messages here go to Ember as before, with everything that was said.",
          "Remote Control",
        );
      },
    };
  }

  private manager(): Remotes | undefined {
    const terms = this.deps.terminals();
    if (!terms) return undefined;
    this.remotes ??= new Remotes(terms, this.hub());
    return this.remotes;
  }

  /** The live session of a conversation, for the chat (absent when Remote Control is off). */
  status(conversationId: string) {
    const r = this.manager()?.get(slugOf(conversationId));
    return r ? { title: r.title, url: r.url ?? undefined, connecting: !r.url } : undefined;
  }

  /**
   * A message for this conversation: /rc turns Remote Control on or off; while it is on, what the
   * owner types goes into the live session. Returns undefined when it is an ordinary message.
   */
  async handle(
    conversationId: string,
    text: string,
    attachments = 0,
  ): Promise<{ reply: string } | undefined> {
    const rc = RC_COMMAND.exec(text.trim());
    const r = this.manager()?.get(slugOf(conversationId));
    if (!rc && !r) return undefined;
    await this.deps.say(conversationId, "you", text.trim());
    if (rc) {
      const arg = (rc[1] ?? "on").toLowerCase();
      let reply: string;
      // A plain /rc switches it: on when it is off, off when it is on (as in Claude Code).
      if (["stop", "off", "end"].includes(arg) || (arg === "on" && r)) {
        reply = r
          ? "Remote Control is off. Type /rc to turn it back on."
          : "Remote Control isn't on.";
        if (r) this.quiet.add(conversationId);
        r?.stop();
      } else if (arg === "status") {
        reply = r
          ? r.url
            ? `Remote Control is on: ${r.url}`
            : "Remote Control is still connecting…"
          : "Remote Control isn't on. Type /rc to start it.";
      } else reply = await this.start(conversationId);
      await this.deps.say(conversationId, "note", reply, "Remote Control");
      return { reply };
    }
    // Claude Code is asking something: a number here presses that option.
    const ask = this.live.get(conversationId)?.ask;
    const option = ask?.prompt.options.find((o) => o.key === text.trim());
    if (ask && option) {
      r!.answer(option.key, option.label);
      return { reply: "" };
    }
    r!.send(text);
    if (attachments)
      await this.deps.say(
        conversationId,
        "note",
        "Images can't go into a Remote Control session: send them in the Claude app, or turn /rc off.",
        "Remote Control",
      );
    return { reply: "" };
  }

  /** Starts the live session (on /rc, and again after a restart for those that were on). */
  async start(conversationId: string): Promise<string> {
    const binary = this.deps.binary();
    const remotes = this.manager();
    if (!binary || !remotes) return "Remote Control needs Claude Code on this computer.";
    let s: LairRemoteSetup;
    try {
      s = await this.deps.setup(conversationId);
    } catch (e) {
      return (e as Error).message;
    }
    // Ember's instructions and Hearth's tools, in files only this account can read.
    const dir = mkdtempSync(path.join(tmpdir(), "hearth-lair-rc-"));
    const timer = setInterval(() => void s.renew().catch(() => undefined), RENEW_MS);
    const cleanup = async () => {
      clearInterval(timer);
      rmSync(dir, { recursive: true, force: true });
      await s.release().catch(() => undefined);
    };
    try {
      const system = path.join(dir, "ember.md");
      // One file: Ember's instructions, then Hearth's guide (as every War Room run gets).
      writeFileSync(system, [s.system, hearthGuide()].filter(Boolean).join("\n\n"), {
        mode: 0o600,
      });
      const config = path.join(dir, "mcp.json");
      writeFileSync(
        config,
        JSON.stringify({
          mcpServers: {
            "dragon-control": {
              type: "http",
              url: s.mcpUrl,
              headers: { Authorization: `Bearer ${s.key}` },
            },
          },
        }),
        { mode: 0o600 },
      );
      mkdirSync(s.cwd, { recursive: true });
      this.live.set(conversationId, { cleanup });
      await remotes.start({
        slug: slugOf(conversationId),
        name: s.name,
        title: remoteTitle(this.deps.pcName(), "Lair", s.name),
        note: "You are Ember, in Hearth's Lair. This conversation is open through Remote Control: the owner may type from Hearth or from the Claude app, and both see the same conversation.",
        extra: ["--mcp-config", config, "--append-system-prompt-file", system],
        guide: false,
        // Full access on: the whole Claude Code, as a Lair answer gets. Off: the usual tools,
        // edits accepted, and Hearth's tools, whose changes are still plans the owner approves.
        permissionMode: s.full ? "bypassPermissions" : "acceptEdits",
        allowedTools: s.full ? [] : [...DEFAULT_ALLOWED_TOOLS, "mcp__dragon-control"],
        cwd: s.cwd,
        sid: await this.deps.setting<string | null>(sessionKey(conversationId), null),
        binary,
        ...(this.deps.launch ? { launch: this.deps.launch } : {}),
        ...(this.deps.transcripts ? { transcripts: this.deps.transcripts } : {}),
      });
      return "Starting Remote Control for this conversation…";
    } catch (e) {
      this.live.delete(conversationId);
      await cleanup();
      return `Couldn't start Remote Control: ${(e as Error).message}`;
    }
  }

  /**
   * Ember's instructions changed (her persona): Claude Code reads them only when a session
   * starts, so each live session starts again with the new ones, resuming the same conversation.
   */
  async refresh(why: string) {
    for (const id of [...this.live.keys()]) {
      const r = this.manager()?.get(slugOf(id));
      if (!r) continue;
      this.quiet.add(id);
      r.stop();
      for (let i = 0; i < 50 && this.manager()?.get(slugOf(id)); i++)
        await new Promise((done) => setTimeout(done, 200));
      if (this.manager()?.get(slugOf(id))) continue;
      const said = await this.start(id).catch((e: Error) => e.message);
      await this.deps
        .say(
          id,
          "note",
          `${why} Remote Control started again with it, in the same conversation. ${said}`,
          "Remote Control",
        )
        .catch(() => undefined);
    }
  }

  /** After a restart: the sessions that were on come back on. */
  async restore() {
    for (const id of await this.deps.setting<string[]>(ACTIVE, []))
      if (!this.status(id)) await this.start(id).catch(() => undefined);
  }

  stopAll() {
    this.remotes?.stopAll();
  }
}
