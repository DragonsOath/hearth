import { randomUUID } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import {
  CHANNEL_FIELDS,
  PUBLIC_ROUTES,
  isChannelKind,
  type ChannelKind,
  type OpeningPoint,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { withTransaction } from "../db/tx";
import { recordAudit } from "../store/audit";
import { InvalidRequestError, NotFoundError } from "../store/errors";
import { getSetting, setSetting, SETTING_DEFAULTS } from "../store/settings";
import type { Vault } from "../auth/vault";
import { SUPPORTED_CHANNELS } from "./catalog";
import {
  PROVIDERS,
  RateLimitedError,
  MessageGoneError,
  sendDiscordRich,
  discordWebhookPicture,
  setDiscordWebhookPicture,
  type Attachment,
  type ChannelConfig,
  type Message,
  type Provider,
} from "./providers";
import { channelInfo, lookupBot, sendDiscordBot } from "./discord-bot";
import { relayChannels, relayInvite, relayRegister, relaySend } from "./hearth-bot";
import { telegramBot, telegramChat } from "./telegram";
import { newPushKeys, pushEndpointAllowed, readPushVault, type PushDevice } from "./push";
import { channelIdFrom } from "@dragon-control/core";

/**
 * Decides what to tell you and sends it. Rather than being called from
 * every place an incident changes, it looks at incidents and works out
 * what you have not been told yet, so nothing is sent twice and nothing
 * is missed. Every send (or hold, or failure) is kept in notification_log.
 */

type Event = "needs-you" | "repair-failed" | "auto-repaired" | "resolved" | "critical";
type IncidentRow = typeof t.incidents.$inferSelect;
type ChannelRow = typeof t.notificationChannels.$inferSelect;

/** Everything Change saves in one go. */
export interface ChannelDraft {
  name: string;
  /** Send with: the way it sends. */
  kind: ChannelKind;
  /** That way's settings; a secret left blank keeps the saved one. */
  values: Record<string, string>;
  audience: "private" | "public";
  /** "hold": quiet hours hold what isn't urgent; "any": sent at any hour. */
  quiet: "hold" | "any";
  /** Route ids: which messages it gets. */
  routes: string[];
}

/** The way a destination sent before a switch, kept (token too) for Switch back. */
interface Previous {
  kind: ChannelKind;
  config: ChannelConfig;
  secretId: string | null;
  detail: string | null;
}

/** The last change, for Undo: the destination as it was, and the secret the change made. */
interface UndoSnapshot {
  before: { row: ChannelRow; routes: string[]; previous: Previous | null };
  made?: string;
  at: string;
}

const PREVIOUS = (id: string) => `notify_previous:${id}`;
const UNDO = (id: string) => `notify_undo:${id}`;

/** What each way is called on screen. */
export const KIND_NAMES: Record<ChannelKind, string> = {
  "hearth-bot": "the Hearth bot",
  discord: "a Discord webhook",
  "discord-bot": "your Discord bot",
  email: "email",
  ntfy: "ntfy",
  push: "browser push",
  telegram: "Telegram",
  webhook: "a webhook",
};

/** The kind of channel a row is (a destination you added carries it; built-in ids are kinds). */
export function kindOf(row: Pick<ChannelRow, "id" | "kind">): ChannelKind {
  return (row.kind ?? row.id) as ChannelKind;
}

/** Set up and switched on. */
export function sendable(row: ChannelRow | undefined): row is ChannelRow {
  return row?.status === "configured" && row.enabled !== false;
}

const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 2 * 60_000;
/** Quiet hours, local time: 22:00 to 07:00. */
const QUIET_FROM = 22;
const QUIET_UNTIL = 7;

export interface NotifierDeps {
  providers?: Record<ChannelKind, Provider>;
  /** Local wall-clock time for quiet hours and the Sunday summary (tests set it). */
  localTime?: () => Date;
  /**
   * The Hearth icon (PNG, base64): the picture a Discord destination for media announcements gets
   * when its webhook has none of its own. Never replaces a picture the owner chose.
   */
  defaultPicture?: () => Promise<string | undefined>;
  /** Telegram's API (tests pass a stand-in). */
  telegramFetch?: typeof fetch;
}

export class Notifier {
  private readonly providers: Record<ChannelKind, Provider>;
  private readonly localTime: () => Date;
  private readonly defaultPicture: () => Promise<string | undefined>;
  private readonly telegramFetch: typeof fetch;
  private readonly now = () => new Date();
  private running: Promise<void> | undefined;
  private again = false;
  /**
   * What the companion would open with, since a given time (wired by the
   * app; the notifier only decides when to send it). Unset: no check-ins.
   */
  checkIn?: (since: string) => Promise<OpeningPoint[]>;

  constructor(
    private readonly handle: DbHandle,
    private readonly vault: Vault,
    deps: NotifierDeps = {},
  ) {
    this.providers = deps.providers ?? PROVIDERS;
    this.localTime = deps.localTime ?? (() => new Date());
    this.defaultPicture = deps.defaultPicture ?? (async () => undefined);
    this.telegramFetch = deps.telegramFetch ?? fetch;
  }

  private get db() {
    return this.handle.db;
  }

  /* ---------- Channels ---------- */

  private async channel(id: string): Promise<ChannelRow> {
    const row = await this.db
      .select()
      .from(t.notificationChannels)
      .where(eq(t.notificationChannels.id, id))
      .get();
    if (!row) throw new NotFoundError("No such channel.");
    return row;
  }

  private async secretOf(row: ChannelRow): Promise<string | undefined> {
    if (!row.secretId) return undefined;
    // Sends are recorded in the notification log, so the vault does not audit each one.
    return this.vault.use(row.secretId, `send ${row.name} notifications`, {
      actor: "dragon-control",
      audit: false,
    });
  }

  /** A vault secret by id, for sending or checking (sends are logged, so not audited each). */
  private secretById(id: string | null | undefined, name: string) {
    return id
      ? this.vault.use(id, `send ${name} notifications`, { actor: "dragon-control", audit: false })
      : Promise.resolve(undefined);
  }

  /**
   * Checks a channel's settings for a kind and fills in what the service tells Hearth (the bot's
   * name, the chat, the channel's name). `fallbackSecretId` is the saved secret to use when none
   * was typed: the channel's own for the same kind, or the one kept from before a switch.
   */
  private async prepare(
    row: ChannelRow,
    kind: ChannelKind,
    values: Record<string, string>,
    fallbackSecretId: string | null | undefined,
  ) {
    if (!isChannelKind(kind) || !SUPPORTED_CHANNELS.has(kind)) {
      throw new InvalidRequestError("That channel cannot be set up yet.");
    }
    if (kind === "push")
      throw new InvalidRequestError(
        "Turn browser push on from each device: Notifications, Browser push.",
      );
    const fields = CHANNEL_FIELDS[kind];
    const config: ChannelConfig = {};
    let secret: string | undefined;
    for (const f of fields) {
      const raw = (values[f.key] ?? "").trim();
      if (f.secret) {
        if (raw) secret = raw;
        continue;
      }
      const value = raw || f.defaultValue || "";
      if (f.required && !value) throw new InvalidRequestError(`${f.label} is needed.`);
      if (value) config[f.key] = f.type === "number" ? Number(value) : value;
    }
    const secretField = fields.find((f) => f.secret);
    if (secretField?.required && !secret && !fallbackSecretId) {
      throw new InvalidRequestError(`${secretField.label} is needed.`);
    }
    const saved = () => this.secretById(fallbackSecretId, row.name);
    const provider = this.providers[kind];
    // An unchanged secret was checked when it was saved; only what changed is checked now.
    const problem = provider.validate(config, secret);
    if (problem) throw new InvalidRequestError(problem);
    // Your bot: Discord confirms the token works and the bot can see the channel; its name is kept.
    if (kind === "discord-bot") {
      const token = secret ?? (await saved());
      const channelId = channelIdFrom(String(config.channel))!;
      const info = await channelInfo(token!, channelId).catch((e: unknown) => {
        throw new InvalidRequestError(e instanceof Error ? e.message : String(e));
      });
      config.channel = channelId;
      config.channelName = info.name;
    }
    // Telegram: the token must work, and the chat is the one that last wrote to the bot.
    if (kind === "telegram") {
      const token = (secret ?? (await saved()))!.trim();
      const fail = (e: unknown) => {
        throw new InvalidRequestError(e instanceof Error ? e.message : String(e));
      };
      const bot = await telegramBot(token, this.telegramFetch).catch(fail);
      const chat = await telegramChat(token, this.telegramFetch).catch(fail);
      if (!chat)
        throw new InvalidRequestError(
          `Nobody has written to @${bot!.username} yet. Open it in Telegram (t.me/${bot!.username}), press Start, then Set up again.`,
        );
      config.botName = bot!.username;
      config.chat = chat.id;
      config.chatName = chat.name;
      if (secret !== undefined) secret = secret.trim();
    }
    // The official Hearth bot: the channel must be in a server you added it to.
    let shared: string | undefined;
    if (kind === "hearth-bot") {
      shared = await this.hearthBotSecret(true);
      const cred = await this.vault.use(shared, "set up the Hearth bot", {
        actor: "dragon-control",
        audit: false,
      });
      const channelId = channelIdFrom(String(config.channel))!;
      const found = (await relayChannels(cred)).find((c) => c.id === channelId);
      if (!found)
        throw new InvalidRequestError(
          "That channel is not in a server you added Hearth to. Add Hearth there first.",
        );
      config.channel = channelId;
      config.channelName = found.name;
    }
    return { config, secret, secretField, shared, provider };
  }

  /** Sets up or changes a channel. The secret part goes to the vault. */
  async configure(id: string, values: Record<string, string>, appUrl?: string) {
    const row = await this.channel(id);
    const kind = kindOf(row);
    const { config, secret, secretField, shared, provider } = await this.prepare(
      row,
      kind,
      values,
      row.secretId,
    );
    // Kept through a save: how this destination treats quiet hours (set in Change).
    if (row.config?.quiet === "any") config.quiet = "any";

    let secretId = shared ?? row.secretId;
    if (secret !== undefined) {
      if (secretId && (await this.vault.exists(secretId))) {
        await this.vault.update(secretId, { value: secret });
      } else {
        const added = await this.vault.add({
          name: `${row.name} notifications`,
          kind: secretField?.key === "password" ? "password" : "token",
          tier: "automation",
          value: secret,
        });
        secretId = added.id;
      }
    }

    const first = row.status !== "configured";
    await withTransaction(this.handle, async () => {
      await this.db
        .update(t.notificationChannels)
        .set({ status: "configured", config, secretId, detail: provider.describe(config) })
        .where(eq(t.notificationChannels.id, id));
      // A built-in channel, set up for the first time, hears about everything that matters
      // (except the weekly note). A destination you added starts with nothing: you choose.
      if (first && isChannelKind(row.id)) await this.routeNewChannel(id);
      if (appUrl) await setSetting(this.db, "app_url", appUrl.replace(/\/+$/, ""));
      if (!(await getSetting(this.db, "notify_since"))) {
        await setSetting(this.db, "notify_since", this.now().toISOString());
      }
      await recordAudit(this.db, {
        actor: "you",
        action: first ? `Set up ${row.name} notifications` : `Changed ${row.name} notifications`,
        target: "notifications",
      });
    });
    if (kind === "discord-bot" || kind === "hearth-bot") this.onBotsChanged?.();
  }

  /**
   * The official Hearth bot's registration for this Hearth (one, shared by every destination of
   * that kind): its vault id, registering with the relay the first time when `create`.
   */
  async hearthBotSecret(create: true): Promise<string>;
  async hearthBotSecret(create?: false): Promise<string | undefined>;
  async hearthBotSecret(create = false): Promise<string | undefined> {
    const saved = await getSetting(this.db, "hearth_bot");
    if (saved && (await this.vault.exists(saved.secretId))) return saved.secretId;
    if (!create) return undefined;
    const cred = await relayRegister().catch((e: unknown) => {
      throw new InvalidRequestError(e instanceof Error ? e.message : String(e));
    });
    const added = await this.vault.add({
      name: "Hearth bot connection",
      kind: "token",
      tier: "automation",
      value: cred,
      actor: "dragon-control",
    });
    await setSetting(this.db, "hearth_bot", { secretId: added.id });
    return added.id;
  }

  /** The official Hearth bot's setup: the Add to my server link, or the channels it can post in. */
  async hearthBotSetup(action: "invite" | "channels") {
    const id = await this.hearthBotSecret(true);
    const cred = await this.vault.use(id, "set up the Hearth bot", {
      actor: "dragon-control",
      audit: false,
    });
    try {
      return action === "invite"
        ? { url: await relayInvite(cred) }
        : { channels: await relayChannels(cred) };
    } catch (e) {
      throw new InvalidRequestError(e instanceof Error ? e.message : String(e));
    }
  }

  /** The registration to keep connected, while an official-bot destination is set up. */
  async hearthBotCred(): Promise<string | undefined> {
    const rows = await this.db.select().from(t.notificationChannels);
    if (!rows.some((r) => kindOf(r) === "hearth-bot" && sendable(r))) return undefined;
    const id = await this.hearthBotSecret();
    return id
      ? this.vault.use(id, "connect to the Hearth bot", { actor: "dragon-control", audit: false })
      : undefined;
  }

  /** Called when a bot destination is set up or changed, so its connection is refreshed. */
  onBotsChanged?: () => void;

  /**
   * The setup screen of a bot destination: the bot's name, its add-to-server link, and its
   * channels, read with the token just pasted (not saved yet) or the one in the vault.
   */
  async botLookup(id: string, token?: string) {
    const row = await this.channel(id);
    // A typed token works for any destination (Change, switching to your own bot).
    if (kindOf(row) !== "discord-bot" && !token?.trim())
      throw new InvalidRequestError("Paste the bot token first.");
    const t = token?.trim() || (await this.secretOf(row));
    if (!t) throw new InvalidRequestError("Paste the bot token first.");
    return lookupBot(t).catch((e: unknown) => {
      throw new InvalidRequestError(e instanceof Error ? e.message : String(e));
    });
  }

  /** The tokens of every bot destination that is set up (each is kept connected for buttons). */
  async botTokens(): Promise<string[]> {
    const rows = await this.db.select().from(t.notificationChannels);
    const out = new Set<string>();
    for (const r of rows)
      if (kindOf(r) === "discord-bot" && r.status === "configured" && r.enabled !== false) {
        const token = await this.secretOf(r).catch(() => undefined);
        if (token) out.add(token);
      }
    return [...out];
  }

  /**
   * Adds a destination: another channel of a kind (a second Discord channel for friends, say). It
   * starts not set up, switched on, and routed to nothing.
   */
  async addDestination(input: {
    kind: string;
    name: string;
    audience: "private" | "public";
  }): Promise<string> {
    if (!isChannelKind(input.kind) || !SUPPORTED_CHANNELS.has(input.kind))
      throw new InvalidRequestError("That kind of channel cannot be added yet.");
    const name = input.name.trim().slice(0, 60);
    if (!name) throw new InvalidRequestError("Give it a name.");
    const all = await this.db.select().from(t.notificationChannels);
    if (all.some((c) => c.name.toLowerCase() === name.toLowerCase()))
      throw new InvalidRequestError(`There is already a channel called ${name}.`);
    const id = `${input.kind}-${randomUUID().slice(0, 8)}`;
    await this.db.insert(t.notificationChannels).values({
      id,
      name,
      status: "available",
      detail: null,
      kind: input.kind,
      audience: input.audience,
      enabled: true,
      sort: 100 + all.length,
    });
    await recordAudit(this.db, {
      actor: "you",
      action: `Added the ${name} notification destination`,
      target: "notifications",
    });
    return id;
  }

  /** Switches a channel on or off, keeping its settings. */
  async setEnabled(id: string, enabled: boolean) {
    const row = await this.channel(id);
    await this.db
      .update(t.notificationChannels)
      .set({ enabled })
      .where(eq(t.notificationChannels.id, id));
    await recordAudit(this.db, {
      actor: "you",
      action: `${enabled ? "Switched on" : "Switched off"} ${row.name} notifications`,
      target: "notifications",
    });
    if (kindOf(row) === "discord-bot" || kindOf(row) === "hearth-bot") this.onBotsChanged?.();
  }

  async remove(id: string) {
    const row = await this.channel(id);
    await withTransaction(this.handle, async () => {
      // The official bot's registration is shared by all its destinations: it stays.
      if (row.secretId && kindOf(row) !== "hearth-bot")
        await this.vault.removeInternal(row.secretId);
      // A destination you added goes away entirely; a built-in channel goes back to "available".
      if (!isChannelKind(row.id))
        await this.db.delete(t.notificationChannels).where(eq(t.notificationChannels.id, id));
      else
        await this.db
          .update(t.notificationChannels)
          .set({ status: "available", config: null, secretId: null, detail: null })
          .where(eq(t.notificationChannels.id, id));
      for (const route of await this.db.select().from(t.notificationRoutes)) {
        if (!route.channels.includes(id)) continue;
        await this.db
          .update(t.notificationRoutes)
          .set({ channels: route.channels.filter((c) => c !== id) })
          .where(eq(t.notificationRoutes.id, route.id));
      }
      await recordAudit(this.db, {
        actor: "you",
        action: `Stopped ${row.name} notifications`,
        target: "notifications",
      });
    });
    // What Change kept (the way it sent before, the last change to undo) goes with it.
    const kept = [
      (await this.kvGet<Previous>(PREVIOUS(id)))?.secretId,
      (await this.kvGet<UndoSnapshot>(UNDO(id)))?.made,
    ];
    await this.kvDel(PREVIOUS(id));
    await this.kvDel(UNDO(id));
    await this.sweep(kept);
    if (kindOf(row) === "discord-bot" || kindOf(row) === "hearth-bot") this.onBotsChanged?.();
  }

  /* ---------- Change: one save for everything about a destination (11-13) ---------- */

  private async kvGet<T>(key: string): Promise<T | undefined> {
    const r = await this.db.select().from(t.settings).where(eq(t.settings.key, key)).get();
    return (r?.value ?? undefined) as T | undefined;
  }

  private async kvSet(key: string, value: unknown) {
    await this.db
      .insert(t.settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: t.settings.key, set: { value } });
  }

  private async kvDel(key: string) {
    await this.db.delete(t.settings).where(eq(t.settings.key, key));
  }

  /** Route ids that send to this destination now. */
  private async routesOf(id: string) {
    return (await this.db.select().from(t.notificationRoutes))
      .filter((r) => r.channels.includes(id))
      .map((r) => r.id);
  }

  private async setRoutesOf(id: string, wanted: string[]) {
    for (const route of await this.db.select().from(t.notificationRoutes)) {
      const has = route.channels.includes(id);
      const want = wanted.includes(route.id);
      if (has === want) continue;
      await this.db
        .update(t.notificationRoutes)
        .set({ channels: want ? [...route.channels, id] : route.channels.filter((c) => c !== id) })
        .where(eq(t.notificationRoutes.id, route.id));
    }
  }

  /** Vault entries no destination, kept way or undo uses any more go (never the shared bot's). */
  private async sweep(ids: (string | null | undefined)[]) {
    const shared = (await getSetting(this.db, "hearth_bot"))?.secretId;
    const rows = await this.db.select().from(t.notificationChannels);
    const used = new Set<string>(rows.map((r) => r.secretId ?? "").filter(Boolean));
    for (const r of rows) {
      used.add((await this.kvGet<Previous>(PREVIOUS(r.id)))?.secretId ?? "");
      const u = await this.kvGet<UndoSnapshot>(UNDO(r.id));
      used.add(u?.before.row.secretId ?? "");
      used.add(u?.before.previous?.secretId ?? "");
    }
    for (const id of new Set(ids)) {
      if (!id || id === shared || used.has(id)) continue;
      if (await this.vault.exists(id)) await this.vault.removeInternal(id);
    }
  }

  /** The checks a change needs before anything is tried or saved. */
  private async checkDraft(row: ChannelRow, draft: ChannelDraft) {
    const from = kindOf(row);
    if (from === "push" || draft.kind === "push")
      throw new InvalidRequestError(
        "Browser push is turned on from each device, so it can't be switched to another way.",
      );
    const name = draft.name.trim().slice(0, 60);
    if (!name) throw new InvalidRequestError("Give it a name.");
    const all = await this.db.select().from(t.notificationChannels);
    if (all.some((c) => c.id !== row.id && c.name.toLowerCase() === name.toLowerCase()))
      throw new InvalidRequestError(`There is already a channel called ${name}.`);
    const routes = await this.db.select().from(t.notificationRoutes);
    const unknown = draft.routes.filter((r) => !routes.some((x) => x.id === r));
    if (unknown.length) throw new InvalidRequestError("Some of those messages don't exist.");
    if (draft.audience === "public") {
      const not = draft.routes.filter((r) => !PUBLIC_ROUTES.includes(r));
      if (not.length)
        throw new InvalidRequestError(
          `Friends and family get media announcements only: ${not
            .map((r) => routes.find((x) => x.id === r)!.event)
            .join(", ")} can't go there.`,
        );
    }
    const previous = await this.kvGet<Previous>(PREVIOUS(row.id));
    const fallback =
      draft.kind === from ? row.secretId : previous?.kind === draft.kind ? previous.secretId : null;
    return { name, from, previous, fallback };
  }

  /**
   * Sends a test with settings not saved yet (Send test, in Change), so a new way is proven
   * before it replaces the old one. Nothing is kept: a token typed here is not stored.
   */
  async tryDraft(id: string, draft: ChannelDraft): Promise<{ ok: boolean; error?: string }> {
    const row = await this.channel(id);
    const { name, fallback } = await this.checkDraft(row, draft);
    const p = await this.prepare(row, draft.kind, draft.values, fallback);
    const secret =
      p.secret ??
      (p.shared
        ? await this.vault.use(p.shared, "test the Hearth bot", {
            actor: "dragon-control",
            audit: false,
          })
        : await this.secretById(fallback, row.name));
    const instance = (await getSetting(this.db, "instance_name")) ?? SETTING_DEFAULTS.instance_name;
    const message: Message = {
      title: "Test from Hearth",
      lines: [
        `This is a test from Hearth on ${instance}, with the changes to ${name} not saved yet. If you can read it, they work.`,
      ],
      severity: "info",
    };
    try {
      await this.providers[draft.kind].send(message, p.config, secret);
      await this.log({ event: "test", channelId: id, title: message.title, status: "sent" });
      return { ok: true };
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      await this.log({
        event: "test",
        channelId: id,
        title: message.title,
        status: "failed",
        error: reason,
      });
      return { ok: false, error: reason };
    }
  }

  /**
   * One save for everything about a destination: its name, the way it sends (Send with), that
   * way's settings and secret, who reads it, quiet hours and which messages it gets. The id stays,
   * so its history, media and movie-night use stay with it. Switching the way keeps the old one
   * (its token too) for Switch back; the save can be undone.
   */
  async change(id: string, draft: ChannelDraft, appUrl?: string) {
    const row = await this.channel(id);
    const { name, from, previous, fallback } = await this.checkDraft(row, draft);
    const p = await this.prepare(row, draft.kind, draft.values, fallback);
    if (draft.quiet === "any") p.config.quiet = "any";
    // A new secret is a new vault entry: the old one stays until nothing (Switch back, Undo)
    // needs it.
    let secretId = p.shared ?? fallback ?? null;
    let made: string | undefined;
    if (p.secret !== undefined) {
      const added = await this.vault.add({
        name: `${name} notifications`,
        kind: p.secretField?.key === "password" ? "password" : "token",
        tier: "automation",
        value: p.secret,
      });
      secretId = made = added.id;
    }
    const before: UndoSnapshot["before"] = {
      row,
      routes: await this.routesOf(id),
      previous: previous ?? null,
    };
    const replaced = await this.kvGet<UndoSnapshot>(UNDO(id));
    const switched = draft.kind !== from;
    const what = [
      name !== row.name && `renamed to ${name}`,
      switched && `now sent with ${KIND_NAMES[draft.kind]}`,
      draft.audience !== (row.audience ?? "private") &&
        (draft.audience === "public" ? "for friends and family" : "just for you"),
    ].filter(Boolean);
    await withTransaction(this.handle, async () => {
      await this.db
        .update(t.notificationChannels)
        .set({
          name,
          kind: isChannelKind(row.id) && draft.kind === row.id ? null : draft.kind,
          status: "configured",
          config: p.config,
          secretId,
          detail: p.provider.describe(p.config),
          audience: draft.audience,
        })
        .where(eq(t.notificationChannels.id, id));
      await this.setRoutesOf(id, draft.routes);
      if (switched && row.status === "configured")
        await this.kvSet(PREVIOUS(id), {
          kind: from,
          config: row.config ?? {},
          secretId: row.secretId,
          detail: row.detail,
        } satisfies Previous);
      await this.kvSet(UNDO(id), {
        before,
        made,
        at: this.now().toISOString(),
      } satisfies UndoSnapshot);
      if (appUrl) await setSetting(this.db, "app_url", appUrl.replace(/\/+$/, ""));
      if (!(await getSetting(this.db, "notify_since")))
        await setSetting(this.db, "notify_since", this.now().toISOString());
      await recordAudit(this.db, {
        actor: "you",
        action: `Changed ${row.name} notifications${what.length ? `: ${what.join(", ")}` : ""}`,
        target: "notifications",
        detail: { channel: id, undo: "notification-change" },
      });
    });
    // The change it replaced can no longer be undone: what only it needed goes.
    if (replaced) await this.sweep([replaced.made, replaced.before.row.secretId]);
    if ([from, draft.kind].some((k) => k === "discord-bot" || k === "hearth-bot"))
      this.onBotsChanged?.();
  }

  /** Back to the way it sent before the last switch (its settings and token were kept). */
  async switchBack(id: string) {
    const row = await this.channel(id);
    const previous = await this.kvGet<Previous>(PREVIOUS(id));
    if (!previous) throw new InvalidRequestError("There is no earlier way to switch back to.");
    const from = kindOf(row);
    const before: UndoSnapshot["before"] = { row, routes: await this.routesOf(id), previous };
    const replaced = await this.kvGet<UndoSnapshot>(UNDO(id));
    // Quiet hours are this destination's choice, not the way's: they stay.
    const config = { ...previous.config };
    if (row.config?.quiet === "any") config.quiet = "any";
    else delete config.quiet;
    await withTransaction(this.handle, async () => {
      await this.db
        .update(t.notificationChannels)
        .set({
          kind: isChannelKind(row.id) && previous.kind === row.id ? null : previous.kind,
          status: "configured",
          config,
          secretId: previous.secretId,
          detail: previous.detail,
        })
        .where(eq(t.notificationChannels.id, id));
      await this.kvSet(PREVIOUS(id), {
        kind: from,
        config: row.config ?? {},
        secretId: row.secretId,
        detail: row.detail,
      } satisfies Previous);
      await this.kvSet(UNDO(id), { before, at: this.now().toISOString() } satisfies UndoSnapshot);
      await recordAudit(this.db, {
        actor: "you",
        action: `Switched ${row.name} back to ${KIND_NAMES[previous.kind]}`,
        target: "notifications",
        detail: { channel: id, undo: "notification-change" },
      });
    });
    if (replaced) await this.sweep([replaced.made, replaced.before.row.secretId]);
    if ([from, previous.kind].some((k) => k === "discord-bot" || k === "hearth-bot"))
      this.onBotsChanged?.();
  }

  /** Forget the earlier way (and its token): Switch back is no longer offered. */
  async forgetPrevious(id: string) {
    const row = await this.channel(id);
    const previous = await this.kvGet<Previous>(PREVIOUS(id));
    if (!previous) return;
    await this.kvDel(PREVIOUS(id));
    await recordAudit(this.db, {
      actor: "you",
      action: `Forgot the old ${KIND_NAMES[previous.kind]} settings of ${row.name}`,
      target: "notifications",
    });
    await this.sweep([previous.secretId]);
  }

  /** Undo the last change, switch back included: everything as it was before it. */
  async undoChange(id: string) {
    const snap = await this.kvGet<UndoSnapshot>(UNDO(id));
    if (!snap) throw new InvalidRequestError("There is no change to undo.");
    const now = await this.channel(id);
    const { id: _id, ...was } = snap.before.row;
    await withTransaction(this.handle, async () => {
      await this.db
        .update(t.notificationChannels)
        .set(was)
        .where(eq(t.notificationChannels.id, id));
      await this.setRoutesOf(id, snap.before.routes);
      if (snap.before.previous) await this.kvSet(PREVIOUS(id), snap.before.previous);
      else await this.kvDel(PREVIOUS(id));
      await this.kvDel(UNDO(id));
      await recordAudit(this.db, {
        actor: "you",
        action: `Undid the last change to ${was.name} notifications`,
        target: "notifications",
        detail: { channel: id },
      });
    });
    await this.sweep([snap.made, now.secretId]);
    if (
      [kindOf(now), kindOf(snap.before.row)].some((k) => k === "discord-bot" || k === "hearth-bot")
    )
      this.onBotsChanged?.();
  }

  /** For the page: the way kept for Switch back, and whether there is a change to undo. */
  async changeState(): Promise<Record<string, { previous?: ChannelKind; undo?: string }>> {
    const out: Record<string, { previous?: ChannelKind; undo?: string }> = {};
    for (const r of await this.db.select().from(t.notificationChannels)) {
      const previous = (await this.kvGet<Previous>(PREVIOUS(r.id)))?.kind;
      const undo = (await this.kvGet<UndoSnapshot>(UNDO(r.id)))?.at;
      if (previous || undo)
        out[r.id] = { ...(previous ? { previous } : {}), ...(undo ? { undo } : {}) };
    }
    return out;
  }

  async sendTest(id: string): Promise<{ ok: boolean; error?: string }> {
    const row = await this.channel(id);
    if (row.status !== "configured") throw new InvalidRequestError("Set this channel up first.");
    const instance = (await getSetting(this.db, "instance_name")) ?? SETTING_DEFAULTS.instance_name;
    const appUrl = await getSetting(this.db, "app_url");
    const message: Message = {
      title: "Test from Hearth",
      lines: [
        `This is a test message from Hearth on ${instance}. If you can read it, ${row.name} notifications work.`,
      ],
      severity: "info",
      link: appUrl,
    };
    const result = await this.deliver(row, message);
    await this.log({ event: "test", channelId: id, title: message.title, ...result });
    return result.status === "sent" ? { ok: true } : { ok: false, error: result.error };
  }

  /** Destinations that get media announcements now (set up, switched on, routed). */
  async mediaChannels(): Promise<ChannelRow[]> {
    const route = await this.db
      .select()
      .from(t.notificationRoutes)
      .where(eq(t.notificationRoutes.id, "media-arrivals"))
      .get();
    const out: ChannelRow[] = [];
    for (const id of route?.channels ?? []) {
      const row = await this.db
        .select()
        .from(t.notificationChannels)
        .where(eq(t.notificationChannels.id, id))
        .get();
      if (sendable(row)) out.push(row);
    }
    return out;
  }

  /**
   * Where a movie night can be posted: the destinations chosen for New in your library, and every
   * bot destination you set up (their invitations carry RSVP buttons).
   */
  async movieNightChannels(): Promise<(ChannelRow & { buttons: boolean })[]> {
    const media = await this.mediaChannels();
    const bots = (await this.db.select().from(t.notificationChannels)).filter(
      (r) =>
        (kindOf(r) === "discord-bot" || kindOf(r) === "hearth-bot") &&
        sendable(r) &&
        !media.some((m) => m.id === r.id),
    );
    return [...bots, ...media].map((r) => ({
      ...r,
      buttons: kindOf(r) === "discord-bot" || kindOf(r) === "hearth-bot",
    }));
  }

  /**
   * The picture Discord shows beside media announcements: the first Discord destination's own
   * webhook picture (its address in Discord's picture store), or none.
   */
  async mediaSenderPicture(): Promise<string | undefined> {
    for (const row of await this.mediaChannels()) {
      if (kindOf(row) !== "discord") continue;
      const url = await this.secretOf(row);
      if (url) return discordWebhookPicture(url).catch(() => undefined);
    }
    return undefined;
  }

  /**
   * Once per Discord destination, before its first media announcement: a webhook with no picture
   * of its own gets the Hearth icon. One that has a picture keeps it. A failure never stops a post.
   */
  private async pictureOnce(row: ChannelRow, url: string) {
    const done = (await getSetting(this.db, "media_picture_checked")) ?? [];
    if (done.includes(row.id)) return;
    try {
      if (!(await discordWebhookPicture(url))) {
        const icon = await this.defaultPicture();
        if (icon) await setDiscordWebhookPicture(url, "image/png", icon);
      }
      await setSetting(this.db, "media_picture_checked", [...done, row.id]);
    } catch {
      // Checked again before the next announcement.
    }
  }

  /** Sets the picture on every Discord destination that gets media announcements. */
  async setMediaSenderPicture(
    mime: string,
    base64: string,
  ): Promise<{ set: string[]; failed: { name: string; error: string }[] }> {
    const out = { set: [] as string[], failed: [] as { name: string; error: string }[] };
    for (const row of await this.mediaChannels()) {
      if (kindOf(row) !== "discord") continue;
      try {
        const url = await this.secretOf(row);
        if (!url) throw new Error("Set this destination up first.");
        await setDiscordWebhookPicture(url, mime, base64);
        out.set.push(row.name);
      } catch (error) {
        out.failed.push({
          name: row.name,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
        });
      }
    }
    if (!out.set.length && !out.failed.length)
      throw new InvalidRequestError(
        "Choose a Discord destination for New in your library first: the picture belongs to it.",
      );
    if (out.set.length)
      await recordAudit(this.db, {
        actor: "you",
        action: `Changed the announcement picture on ${out.set.join(", ")}`,
        target: "notifications",
      });
    return out;
  }

  /**
   * A media announcement to one destination: Discord gets the rich message with its pictures
   * attached; other kinds get the plain version. Never a link into Hearth. Logged like any send.
   */
  async sendMedia(
    channelId: string,
    rich: { payload: Record<string, unknown>; files: Attachment[]; components?: unknown[] },
    plain: Message,
    /**
     * `keep`: Discord gives back the message id (`messageId` in the result) so it can be edited;
     * `edit`: changes that Discord message instead of posting (a new one if it was deleted).
     * Other kinds of destination always get a new message.
     */
    opts: { test?: boolean; event?: string; keep?: boolean; edit?: string } = {},
  ): Promise<
    { ok: true; messageId?: string } | { ok: false; error: string; retryAfterMs?: number }
  > {
    const row = await this.channel(channelId);
    if (row.status !== "configured") return { ok: false, error: "Set this destination up first." };
    let result:
      { ok: true; messageId?: string } | { ok: false; error: string; retryAfterMs?: number };
    try {
      const kind = kindOf(row);
      const secret = await this.secretOf(row);
      if (kind === "discord") {
        await this.pictureOnce(row, secret!);
        let messageId: string | undefined;
        try {
          messageId = await sendDiscordRich(secret!, rich.payload, rich.files, {
            wait: opts.keep,
            ...(opts.edit ? { messageId: opts.edit } : {}),
          });
        } catch (error) {
          if (!(error instanceof MessageGoneError)) throw error;
          messageId = await sendDiscordRich(secret!, rich.payload, rich.files, { wait: true });
        }
        result = { ok: true, ...(messageId ? { messageId } : {}) };
      } else if (kind === "discord-bot") {
        // Your bot's messages can carry buttons (a webhook's cannot).
        const channelId = String(row.config?.channel ?? "");
        const opts2 = rich.components ? { components: rich.components } : {};
        let messageId: string;
        try {
          messageId = await sendDiscordBot(secret!, channelId, rich.payload, rich.files, {
            ...opts2,
            ...(opts.edit ? { messageId: opts.edit } : {}),
          });
        } catch (error) {
          if (!(error instanceof MessageGoneError)) throw error;
          messageId = await sendDiscordBot(secret!, channelId, rich.payload, rich.files, opts2);
        }
        result = { ok: true, ...(messageId ? { messageId } : {}) };
      } else if (kind === "hearth-bot") {
        const channelId = String(row.config?.channel ?? "");
        const extra = rich.components ? { components: rich.components } : {};
        let messageId: string;
        try {
          messageId = await relaySend(secret!, channelId, rich.payload, rich.files, {
            ...extra,
            ...(opts.edit ? { messageId: opts.edit } : {}),
          });
        } catch (error) {
          if (!(error instanceof MessageGoneError)) throw error;
          messageId = await relaySend(secret!, channelId, rich.payload, rich.files, extra);
        }
        result = { ok: true, ...(messageId ? { messageId } : {}) };
      } else {
        await this.providers[kind].send({ ...plain, link: undefined }, row.config ?? {}, secret);
        result = { ok: true };
      }
    } catch (error) {
      result = {
        ok: false,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
        ...(error instanceof RateLimitedError ? { retryAfterMs: error.retryAfterMs } : {}),
      };
    }
    await this.log({
      event: opts.event ?? (opts.test ? "media-test" : "media"),
      channelId,
      title: plain.title,
      status: result.ok ? "sent" : "failed",
      ...(result.ok ? {} : { error: result.error }),
    });
    return result;
  }

  private async deliver(row: ChannelRow, message: Message) {
    try {
      const kind = kindOf(row);
      // Friends and family never get a link into Hearth (it can carry an internal address).
      const safe = row.audience === "public" ? { ...message, link: undefined } : message;
      const r = await this.providers[kind].send(safe, row.config ?? {}, await this.secretOf(row));
      // Browser push: devices whose browser forgot Hearth are dropped.
      if (kind === "push" && r && r.gone?.length) {
        const vault = await this.pushVault(row);
        if (vault)
          await this.savePush(
            row,
            vault.devices.filter((d) => !r.gone!.includes(d.endpoint)),
          );
      }
      return { status: "sent" as const, error: undefined };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { status: "failed" as const, error: reason.slice(0, 300) };
    }
  }

  private async log(entry: {
    event: string;
    incidentId?: string;
    channelId: string;
    title: string;
    status: "sent" | "held" | "failed";
    error?: string;
  }) {
    const at = this.now().toISOString();
    await this.db.insert(t.notificationLog).values({
      ...entry,
      incidentId: entry.incidentId ?? null,
      error: entry.error ?? null,
      at,
      sentAt: entry.status === "sent" ? at : null,
    });
  }

  /* ---------- What to tell you ---------- */

  private quietNow(): Promise<boolean> {
    return getSetting(this.db, "quiet_hours").then((on) => {
      const hour = this.localTime().getHours();
      return (on ?? SETTING_DEFAULTS.quiet_hours) && (hour >= QUIET_FROM || hour < QUIET_UNTIL);
    });
  }

  /** Asks for a scan soon; scans never overlap. */
  kick() {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          await this.scan();
        } catch (error) {
          console.error("Hearth: notification scan failed", error);
        }
      } while (this.again);
    })().finally(() => {
      this.running = undefined;
    });
  }

  async idle() {
    while (this.running) await this.running;
  }

  private eventsFor(
    incident: IncidentRow,
    lastKind: string | undefined,
    repairFailed: boolean,
  ): Event[] {
    const events: Event[] = [];
    if (incident.severity === "critical" && incident.status !== "resolved") events.push("critical");
    if (incident.status === "resolved") {
      events.push(incident.handledBy === "runbook" ? "auto-repaired" : "resolved");
    } else if (incident.status === "awaiting-approval") {
      events.push("needs-you");
    } else if (incident.status === "open" && lastKind === "escalated") {
      events.push(repairFailed ? "repair-failed" : "needs-you");
    }
    return events;
  }

  async scan(): Promise<void> {
    const db = this.db;
    const since = await getSetting(db, "notify_since");
    if (!since) return;
    const channels = new Map(
      (await db.select().from(t.notificationChannels))
        .filter((c) => sendable(c) && c.audience !== "public")
        .map((c) => [c.id, c]),
    );
    if (!channels.size) return;
    const routes = new Map((await db.select().from(t.notificationRoutes)).map((r) => [r.id, r]));
    const quiet = await this.quietNow();
    const weekAgo = new Date(this.now().getTime() - 7 * 86_400_000).toISOString();
    const incidents = await db
      .select()
      .from(t.incidents)
      .where(gte(t.incidents.openedAt, since > weekAgo ? since : weekAgo));
    const logs = await db
      .select()
      .from(t.notificationLog)
      .where(gte(t.notificationLog.at, weekAgo))
      .orderBy(desc(t.notificationLog.id));
    const latest = new Map<string, (typeof logs)[number]>();
    for (const l of logs) {
      const key = `${l.incidentId}:${l.event}:${l.channelId}`;
      if (!latest.has(key)) latest.set(key, l);
    }

    for (const incident of incidents) {
      const timeline = await db
        .select()
        .from(t.incidentTimeline)
        .where(eq(t.incidentTimeline.incidentId, incident.id))
        .orderBy(desc(t.incidentTimeline.id))
        .limit(1)
        .get();
      const failedRepair = await db
        .select()
        .from(t.actions)
        .where(and(eq(t.actions.incidentId, incident.id), eq(t.actions.status, "failed")))
        .get();
      for (const event of this.eventsFor(incident, timeline?.kind, Boolean(failedRepair))) {
        const targets =
          event === "resolved"
            ? // Only follow up where you were told something was wrong.
              [...channels.keys()].filter((c) =>
                ["needs-you", "repair-failed", "critical"].some(
                  (e) => latest.get(`${incident.id}:${e}:${c}`)?.status === "sent",
                ),
              )
            : (routes.get(event)?.channels ?? []).filter((c) => channels.has(c));
        for (const channelId of targets) {
          const prior = latest.get(`${incident.id}:${event}:${channelId}`);
          if (prior?.status === "sent") continue;
          if (
            prior?.status === "failed" &&
            (prior.attempts >= MAX_ATTEMPTS ||
              this.now().getTime() - Date.parse(prior.at) < RETRY_AFTER_MS)
          ) {
            continue;
          }
          const holds =
            quiet && event !== "critical" && channels.get(channelId)?.config?.quiet !== "any";
          if (prior?.status === "held" && holds) continue;
          const message = await this.compose(incident, event);
          if (holds) {
            await this.log({
              event,
              incidentId: incident.id,
              channelId,
              title: message.title,
              status: "held",
            });
            continue;
          }
          const result = await this.deliver(channels.get(channelId)!, message);
          if (prior) {
            await db
              .update(t.notificationLog)
              .set({
                status: result.status,
                error: result.error ?? null,
                attempts: prior.status === "failed" ? prior.attempts + 1 : prior.attempts,
                at: this.now().toISOString(),
                sentAt: result.status === "sent" ? this.now().toISOString() : null,
              })
              .where(eq(t.notificationLog.id, prior.id));
          } else {
            await this.log({
              event,
              incidentId: incident.id,
              channelId,
              title: message.title,
              ...result,
            });
          }
        }
      }
    }
    await this.weekly(channels, routes.get("weekly")?.channels ?? [], quiet);
    await this.checkInNote(channels, routes.get("check-in")?.channels ?? [], quiet);
  }

  /**
   * The companion reaching out: once a day at most, in the daytime, about
   * your real systems only, and only when there is something new to say.
   * The same words twice are never sent.
   */
  private async checkInNote(channels: Map<string, ChannelRow>, routed: string[], quiet: boolean) {
    const targets = routed.filter((c) => channels.has(c));
    if (!targets.length || quiet || !this.checkIn) return;
    if ((await getSetting(this.db, "environment")) !== "real") return;
    const local = this.localTime();
    if (local.getHours() < 9 || local.getHours() >= 21) return;
    const today = `${local.getFullYear()}-${local.getMonth() + 1}-${local.getDate()}`;
    if ((await getSetting(this.db, "checkin_sent_on")) === today) return;
    const since =
      (await getSetting(this.db, "checkin_sent_at")) ??
      new Date(this.now().getTime() - 86_400_000).toISOString();
    const points = await this.checkIn(since);
    // News is something recorded or raised that was not in an earlier check-in.
    // Open work, and counts that change by themselves ("healthy for 9 days"), are not.
    let said: string[] = [];
    try {
      said = JSON.parse((await getSetting(this.db, "checkin_last")) ?? "[]") as string[];
    } catch {
      said = [];
    }
    const news = points.filter(
      (p) => p.kind !== "in-progress" && !(p.kind === "win" && !p.ref) && !said.includes(p.text),
    );
    if (!news.length) return;
    const instance = (await getSetting(this.db, "instance_name")) ?? SETTING_DEFAULTS.instance_name;
    const appUrl = await getSetting(this.db, "app_url");
    const message: Message = {
      title: `What's up on ${instance}`,
      lines: points.slice(0, 6).map((p) => p.text),
      severity: "info",
      link: appUrl,
    };
    for (const channelId of targets) {
      const result = await this.deliver(channels.get(channelId)!, message);
      await this.log({ event: "check-in", channelId, title: message.title, ...result });
    }
    await setSetting(this.db, "checkin_sent_on", today);
    await setSetting(this.db, "checkin_sent_at", this.now().toISOString());
    await setSetting(
      this.db,
      "checkin_last",
      JSON.stringify([...points.map((p) => p.text), ...said].slice(0, 60)),
    );
  }

  private async compose(incident: IncidentRow, event: Event): Promise<Message> {
    const db = this.db;
    const instance = (await getSetting(db, "instance_name")) ?? SETTING_DEFAULTS.instance_name;
    const sample = (await getSetting(db, "environment")) === "demo";
    const appUrl = await getSetting(db, "app_url");
    const last = await db
      .select()
      .from(t.incidentTimeline)
      .where(eq(t.incidentTimeline.incidentId, incident.id))
      .orderBy(desc(t.incidentTimeline.id))
      .limit(1)
      .get();
    const prefix = sample ? "[Sample data] " : "";
    const sign = `Hearth on ${instance}${sample ? " (sample data, not your systems)" : ""}.`;
    const link = appUrl ? `${appUrl}/incidents/${incident.id}` : undefined;
    switch (event) {
      case "auto-repaired":
        return {
          title: `${prefix}Fixed: ${incident.title}`,
          lines: [incident.resolution ?? "Fixed automatically and verified.", sign],
          severity: "info",
          link,
        };
      case "resolved":
        return {
          title: `${prefix}Resolved: ${incident.title}`,
          lines: [incident.resolution ?? "It is working again. Nothing is needed from you.", sign],
          severity: "info",
          link,
        };
      case "critical":
        return {
          title: `${prefix}Critical: ${incident.title}`,
          lines: [incident.summary, last?.text ?? "", sign].filter(Boolean),
          severity: "critical",
          link,
        };
      case "repair-failed":
        return {
          title: `${prefix}Repair did not work: ${incident.title}`,
          lines: [incident.summary, last?.text ?? "Waiting for you.", sign],
          severity: "warning",
          link,
        };
      default:
        return {
          title: `${prefix}Needs you: ${incident.title}`,
          lines: [
            incident.summary,
            incident.status === "awaiting-approval" && incident.proposedAction
              ? `Proposed repair: ${incident.proposedAction} Open Hearth to approve or decline it.`
              : (last?.text ?? "Waiting for you."),
            sign,
          ],
          severity: "warning",
          link,
        };
    }
  }

  /** A conversation answer that arrived after the asker stopped waiting (e.g. Belle said "I'll let you know"). */
  async announceReply(conversationId: string) {
    const db = this.db;
    const last = await db
      .select()
      .from(t.conversationMessages)
      .where(eq(t.conversationMessages.conversationId, conversationId))
      .orderBy(desc(t.conversationMessages.id))
      .limit(1)
      .get();
    if (!last || last.role !== "agent") return;
    const route = await db
      .select()
      .from(t.notificationRoutes)
      .where(eq(t.notificationRoutes.id, "agent-replies"))
      .get();
    const appUrl = await getSetting(db, "app_url");
    const message: Message = {
      title: "Your AI operator replied",
      lines: [last.text],
      severity: "info",
      link: appUrl ? `${appUrl}/agent` : undefined,
    };
    for (const channelId of route?.channels ?? []) {
      const channel = await db
        .select()
        .from(t.notificationChannels)
        .where(eq(t.notificationChannels.id, channelId))
        .get();
      if (!sendable(channel)) continue;
      const result = await this.deliver(channel, message);
      await this.log({ event: "agent-reply", channelId, title: message.title, ...result });
    }
  }

  /**
   * Long work that stalled, failed, ran past its stop time, or finished (work/service.ts decides
   * which, once each). Problems go out at any hour; "finished" is held during quiet hours.
   */
  async announceWork(alerts: import("../work/service").WorkAlert[]) {
    if (!alerts.length) return;
    const db = this.db;
    const route = await db
      .select()
      .from(t.notificationRoutes)
      .where(eq(t.notificationRoutes.id, "long-work"))
      .get();
    const quiet = await this.quietNow();
    const appUrl = await getSetting(db, "app_url");
    for (const { kind, work } of alerts) {
      const progress = work.progress !== undefined ? ` at ${Math.round(work.progress)}%` : "";
      const message: Message = {
        title:
          kind === "stalled"
            ? `${work.title} has gone quiet`
            : kind === "overdue"
              ? `${work.title} is running past its stop time`
              : kind === "failed"
                ? `${work.title} failed`
                : `${work.title} finished`,
        lines: [
          kind === "stalled"
            ? `No progress report from ${work.machine} for over ${work.stallMinutes} minutes${progress}.`
            : kind === "overdue"
              ? `It was meant to be done by ${new Date(work.stopBy!).toLocaleString("en-US", { hour: "numeric", minute: "2-digit", weekday: "short" })} and is still going on ${work.machine}${progress}.`
              : kind === "failed"
                ? `It stopped with a failure on ${work.machine}${progress}.`
                : `It finished on ${work.machine}.`,
          ...(work.detail ? [`Last report: ${work.detail}`] : []),
        ],
        severity: kind === "done" ? "info" : "warning",
        link: appUrl ? `${appUrl}/jobs` : undefined,
      };
      for (const channelId of route?.channels ?? []) {
        const channel = await db
          .select()
          .from(t.notificationChannels)
          .where(eq(t.notificationChannels.id, channelId))
          .get();
        if (!sendable(channel)) continue;
        if (kind === "done" && quiet && channel.config?.quiet !== "any") {
          await this.log({
            event: "long-work",
            incidentId: `work:${work.id}`,
            channelId,
            title: message.title,
            status: "held",
          });
          continue;
        }
        const result = await this.deliver(channel, message);
        await this.log({
          event: "long-work",
          incidentId: `work:${work.id}`,
          channelId,
          title: message.title,
          ...result,
        });
      }
    }
  }

  /** Whether quiet hours are on now (release watch holds its news until they end). */
  quietHours(): Promise<boolean> {
    return this.quietNow();
  }

  /** Local time as the notifier sees it (tests set it). */
  localNow(): Date {
    return this.localTime();
  }

  /** A new channel hears about everything that matters, except the weekly note and the like. */
  private async routeNewChannel(id: string) {
    for (const route of await this.db.select().from(t.notificationRoutes)) {
      if (
        route.id === "weekly" ||
        route.id === "check-in" ||
        route.id === "agent-replies" ||
        // Media announcements are for the channels you choose (usually friends and family).
        route.id === "media-arrivals" ||
        route.channels.includes(id)
      ) {
        continue;
      }
      await this.db
        .update(t.notificationRoutes)
        .set({ channels: [...route.channels, id] })
        .where(eq(t.notificationRoutes.id, route.id));
    }
  }

  /* ---------- Browser push (notify/push.ts): turned on per device ---------- */

  private async pushRow() {
    return this.channel("push");
  }

  private async pushVault(row: ChannelRow) {
    const raw = row.secretId ? await this.secretOf(row) : undefined;
    return readPushVault(raw);
  }

  /** This Hearth's public key for push (made the first time a device asks). */
  async pushKey(): Promise<string> {
    const row = await this.pushRow();
    const have = await this.pushVault(row);
    if (have) return have.publicKey;
    const keys = newPushKeys();
    const added = await this.vault.add({
      name: "Browser push",
      kind: "token",
      tier: "automation",
      value: JSON.stringify({ ...keys, devices: [] }),
    });
    await this.db
      .update(t.notificationChannels)
      .set({ secretId: added.id })
      .where(eq(t.notificationChannels.id, row.id));
    return keys.publicKey;
  }

  /** Saves the devices; the channel is on while at least one device has it. */
  private async savePush(row: ChannelRow, devices: PushDevice[], appUrl?: string) {
    const vault = (await this.pushVault(row))!;
    await this.vault.update(row.secretId!, { value: JSON.stringify({ ...vault, devices }) });
    const on = devices.length > 0;
    const first = on && row.status !== "configured";
    const config = { devices: devices.length };
    await withTransaction(this.handle, async () => {
      await this.db
        .update(t.notificationChannels)
        .set({
          status: on ? "configured" : "available",
          config,
          detail: on ? this.providers.push.describe(config) : null,
        })
        .where(eq(t.notificationChannels.id, row.id));
      if (first) await this.routeNewChannel(row.id);
      if (appUrl) await setSetting(this.db, "app_url", appUrl.replace(/\/+$/, ""));
      if (on && !(await getSetting(this.db, "notify_since")))
        await setSetting(this.db, "notify_since", this.now().toISOString());
    });
  }

  /** Turns push on for a device (its browser's subscription). */
  async pushSubscribe(
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
    name: string,
    appUrl?: string,
  ) {
    if (!pushEndpointAllowed(sub.endpoint))
      throw new InvalidRequestError("That isn't a browser push service Hearth sends to.");
    await this.pushKey();
    const row = await this.pushRow();
    const vault = (await this.pushVault(row))!;
    const devices = [
      ...vault.devices.filter((d) => d.endpoint !== sub.endpoint),
      {
        endpoint: sub.endpoint,
        keys: sub.keys,
        name: name.slice(0, 60),
        addedAt: this.now().toISOString(),
      },
    ].slice(-20);
    await this.savePush(row, devices, appUrl);
    await recordAudit(this.db, {
      actor: "you",
      action: `Turned on browser push for ${name.slice(0, 60)}`,
      target: "notifications",
    });
  }

  /** Turns push off for a device. */
  async pushUnsubscribe(endpoint: string) {
    const row = await this.pushRow();
    const vault = await this.pushVault(row);
    if (!vault) return;
    const gone = vault.devices.find((d) => d.endpoint === endpoint);
    if (!gone) return;
    await this.savePush(
      row,
      vault.devices.filter((d) => d.endpoint !== endpoint),
    );
    await recordAudit(this.db, {
      actor: "you",
      action: `Turned off browser push for ${gone.name}`,
      target: "notifications",
    });
  }

  /** Which devices have push (names only), and whether this one does. */
  async pushDevices(endpoint?: string) {
    const vault = await this.pushVault(await this.pushRow());
    return {
      devices: (vault?.devices ?? []).map((d) => ({ name: d.name, addedAt: d.addedAt })),
      thisDevice: Boolean(endpoint && vault?.devices.some((d) => d.endpoint === endpoint)),
    };
  }

  /** One message to one channel, logged (briefs and watches, notify/briefs.ts). */
  async sendTo(channelId: string, message: Message, event: string) {
    const row = await this.db
      .select()
      .from(t.notificationChannels)
      .where(eq(t.notificationChannels.id, channelId))
      .get();
    if (!sendable(row))
      return { status: "failed" as const, error: "That channel isn't set up or is switched off." };
    const result = await this.deliver(row, message);
    await this.log({ event, channelId, title: message.title, ...result });
    return result;
  }

  /**
   * One piece of release-watch news (watches/engine.ts decides what is news, once each). Sent on
   * the "Movie releases" channels; "none" when no channel is chosen for it.
   */
  async announceRelease(watchId: string, news: { title: string; text: string; problem: boolean }) {
    const db = this.db;
    const route = await db
      .select()
      .from(t.notificationRoutes)
      .where(eq(t.notificationRoutes.id, "releases"))
      .get();
    const appUrl = await getSetting(db, "app_url");
    const message: Message = {
      title: news.title,
      lines: [news.text],
      severity: news.problem ? "warning" : "info",
      link: appUrl ? `${appUrl}/releases` : undefined,
    };
    let sent = false;
    for (const channelId of route?.channels ?? []) {
      const channel = await db
        .select()
        .from(t.notificationChannels)
        .where(eq(t.notificationChannels.id, channelId))
        .get();
      if (!sendable(channel)) continue;
      const result = await this.deliver(channel, message);
      await this.log({
        event: "release-watch",
        incidentId: `watch:${watchId}`,
        channelId,
        title: message.title,
        ...result,
      });
      if (result.status === "sent") sent = true;
    }
    return sent ? ("sent" as const) : ("none" as const);
  }

  /** A new Hearth release is out (updates/service.ts says so once per version). */
  async announceHearthUpdate(update: { version: string; notes: string; current: string | null }) {
    const db = this.db;
    const route = await db
      .select()
      .from(t.notificationRoutes)
      .where(eq(t.notificationRoutes.id, "hearth-updates"))
      .get();
    const appUrl = await getSetting(db, "app_url");
    const message: Message = {
      title: `Hearth ${update.version} is out`,
      lines: [
        // Already plain words (updates/service.ts plainNotes); a notice keeps the first 6 lines.
        update.notes.split("\n").filter(Boolean).slice(0, 6).join("\n") ||
          "Fixes and improvements.",
        `You have ${update.current ?? "an older version"}. Open Hearth and press Update now when you are ready.`,
      ],
      severity: "info",
      link: appUrl ? `${appUrl}/settings#about` : undefined,
    };
    for (const channelId of route?.channels ?? []) {
      const channel = await db
        .select()
        .from(t.notificationChannels)
        .where(eq(t.notificationChannels.id, channelId))
        .get();
      if (!sendable(channel)) continue;
      const result = await this.deliver(channel, message);
      await this.log({ event: "hearth-updates", channelId, title: message.title, ...result });
    }
  }

  /** Sunday from 09:00, once a week: a short account of the week. */
  private async weekly(channels: Map<string, ChannelRow>, routed: string[], quiet: boolean) {
    const targets = routed.filter((c) => channels.has(c));
    const now = this.localTime();
    if (!targets.length || quiet || now.getDay() !== 0 || now.getHours() < 9) return;
    const week = now.toISOString().slice(0, 10);
    if ((await getSetting(this.db, "weekly_sent_for")) === week) return;
    const weekAgo = new Date(this.now().getTime() - 7 * 86_400_000).toISOString();
    const recent = await this.db
      .select()
      .from(t.incidents)
      .where(gte(t.incidents.openedAt, weekAgo));
    const fixed = recent.filter((i) => i.status === "resolved" && i.handledBy === "runbook").length;
    const byItself = recent.filter((i) => i.handledBy === "recovered").length;
    const open = recent.filter((i) => i.status !== "resolved").length;
    const instance = (await getSetting(this.db, "instance_name")) ?? SETTING_DEFAULTS.instance_name;
    const appUrl = await getSetting(this.db, "app_url");
    const message: Message = {
      title: `Your week on ${instance}`,
      lines: [
        recent.length === 0
          ? "A quiet week: nothing went wrong."
          : `${recent.length} ${recent.length === 1 ? "incident" : "incidents"} this week. ${fixed} fixed automatically, ${byItself} recovered on their own, ${open} still open.`,
        open ? "Open Hearth to see what is waiting for you." : "Nothing is waiting for you.",
      ],
      severity: "info",
      link: appUrl,
    };
    for (const channelId of targets) {
      const result = await this.deliver(channels.get(channelId)!, message);
      await this.log({ event: "weekly", channelId, title: message.title, ...result });
    }
    await setSetting(this.db, "weekly_sent_for", week);
  }
}
