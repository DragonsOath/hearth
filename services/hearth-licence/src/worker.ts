import { WorkerEntrypoint } from "cloudflare:workers";
import {
  emberAnnounced,
  emberPostedIntro,
  emberTold,
  emberView,
  emberWroteStatus,
  HOLD_MINUTES,
  pending,
  seePost,
  type Entry,
  type FounderStore,
  type Offer,
  type PostSeen,
} from "./founder";
import {
  handle,
  type Campaign,
  type Code,
  type EmberSender,
  type Env,
  type Picture,
  type Redemption,
  type Store,
} from "./licence";

/** Hearth's licence service on Cloudflare: the logic is in licence.ts, D1 keeps the records. */

// The few Cloudflare types used here (no extra package needed to build or test).
interface D1Result<T> {
  results: T[];
  meta?: { changes?: number };
}
interface D1Statement {
  bind(...v: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<unknown>>;
}
interface D1Database {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<D1Result<unknown>[]>;
}

interface Bindings extends Env {
  DB: D1Database;
  /** Ember Bot's EmberDesk (a service binding: never reachable from the internet). */
  EMBER?: EmberSender;
}

interface CodeRow {
  id: string;
  hash: string;
  features: string;
  max_uses: number;
  uses: number;
  days: number | null;
  redeem_by: string | null;
  label: string | null;
  active: number;
  campaign_id?: string | null;
  note?: string | null;
  hint?: string | null;
  created_at?: string | null;
}
interface CampaignRow {
  id: string;
  name: string;
  months: number | null;
  cap: number | null;
  gift: number;
  created_at: string;
  active: number;
}
const toCampaign = (r: CampaignRow): Campaign => ({
  id: r.id,
  name: r.name,
  months: r.months,
  cap: r.cap,
  gift: r.gift === 1,
  createdAt: r.created_at,
  active: r.active === 1,
});
const toCode = (r: CodeRow): Code => ({
  id: r.id,
  hash: r.hash,
  features: JSON.parse(r.features) as string[],
  maxUses: r.max_uses,
  uses: r.uses,
  days: r.days,
  redeemBy: r.redeem_by,
  label: r.label,
  active: r.active === 1,
  campaignId: r.campaign_id ?? null,
  note: r.note ?? null,
  hint: r.hint ?? null,
  createdAt: r.created_at ?? null,
});

function d1Store(db: D1Database): Store {
  return {
    async codeByHash(hash) {
      const r = await db.prepare("SELECT * FROM codes WHERE hash = ?").bind(hash).first<CodeRow>();
      return r ? toCode(r) : null;
    },
    async codeById(id) {
      const r = await db.prepare("SELECT * FROM codes WHERE id = ?").bind(id).first<CodeRow>();
      return r ? toCode(r) : null;
    },
    async licencesOf(codeId) {
      return (
        await db
          .prepare("SELECT licence_id FROM redemptions WHERE code_id = ?")
          .bind(codeId)
          .all<{ licence_id: string }>()
      ).results.map((r) => r.licence_id);
    },
    async redeemed(codeId, install) {
      return Boolean(
        await db
          .prepare("SELECT 1 AS x FROM redemptions WHERE code_id = ? AND install = ?")
          .bind(codeId, install)
          .first(),
      );
    },
    async claim(codeId) {
      // One statement: a use is claimed only while one is left, however many redeem at once.
      const r = await db
        .prepare(
          "UPDATE codes SET uses = uses + 1 WHERE id = ? AND active = 1 AND uses < max_uses RETURNING id",
        )
        .bind(codeId)
        .all();
      return r.results.length > 0;
    },
    async unclaim(codeId) {
      await db
        .prepare("UPDATE codes SET uses = uses - 1 WHERE id = ? AND uses > 0")
        .bind(codeId)
        .run();
    },
    async record(r: Redemption) {
      const res = await db
        .prepare(
          "INSERT OR IGNORE INTO redemptions (code_id, install, licence_id, at, ends) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(r.codeId, r.install, r.licenceId, r.at, r.ends)
        .run();
      return (res.meta?.changes ?? 0) > 0;
    },
    async putCode(c) {
      await db
        .prepare(
          `INSERT INTO codes (id, hash, features, max_uses, days, redeem_by, label, active,
             campaign_id, note, hint, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET features = excluded.features, max_uses = excluded.max_uses,
             days = excluded.days, redeem_by = excluded.redeem_by, label = excluded.label,
             active = excluded.active`,
        )
        .bind(
          c.id,
          c.hash,
          JSON.stringify(c.features),
          c.maxUses,
          c.days,
          c.redeemBy,
          c.label,
          c.active ? 1 : 0,
          c.campaignId ?? null,
          c.note ?? null,
          c.hint ?? null,
          c.createdAt ?? null,
        )
        .run();
    },
    async setActive(id, active) {
      const res = await db
        .prepare("UPDATE codes SET active = ? WHERE id = ?")
        .bind(active ? 1 : 0, id)
        .run();
      return (res.meta?.changes ?? 0) > 0;
    },
    async revoke(ids, at) {
      await db.batch(
        ids.map((id) =>
          db.prepare("INSERT OR IGNORE INTO revoked (id, at) VALUES (?, ?)").bind(id, at),
        ),
      );
    },
    async unrevoke(id) {
      await db.prepare("DELETE FROM revoked WHERE id = ?").bind(id).run();
    },
    async revoked() {
      return (await db.prepare("SELECT id FROM revoked").all<{ id: string }>()).results.map(
        (r) => r.id,
      );
    },
    async useNonce(nonce, now) {
      await db
        .prepare("DELETE FROM nonces WHERE at < ?")
        .bind(now - 10 * 60_000)
        .run();
      const res = await db
        .prepare("INSERT OR IGNORE INTO nonces (nonce, at) VALUES (?, ?)")
        .bind(nonce, now)
        .run();
      return (res.meta?.changes ?? 0) > 0;
    },
    async tries(install, now) {
      await db.batch([
        db.prepare("DELETE FROM tries WHERE at < ?").bind(now - 3_600_000),
        db.prepare("INSERT INTO tries (install, at) VALUES (?, ?)").bind(install, now),
      ]);
      const r = await db
        .prepare(
          "SELECT SUM(CASE WHEN at >= ? THEN 1 ELSE 0 END) AS minute, COUNT(*) AS hour FROM tries WHERE install = ?",
        )
        .bind(now - 60_000, install)
        .first<{ minute: number | null; hour: number }>();
      return { minute: r?.minute ?? 0, hour: r?.hour ?? 0 };
    },
    async redemptions() {
      const r = await db
        .prepare(
          "SELECT code_id, install, licence_id, at, ends FROM redemptions ORDER BY at DESC LIMIT 500",
        )
        .all<{
          code_id: string;
          install: string;
          licence_id: string;
          at: string;
          ends: string | null;
        }>();
      return r.results.map((x) => ({
        codeId: x.code_id,
        install: x.install,
        licenceId: x.licence_id,
        at: x.at,
        ends: x.ends,
      }));
    },
    async codes() {
      return (await db.prepare("SELECT * FROM codes").all<CodeRow>()).results.map(toCode);
    },
    async campaigns() {
      return (
        await db.prepare("SELECT * FROM campaigns ORDER BY created_at DESC").all<CampaignRow>()
      ).results.map(toCampaign);
    },
    async campaign(id) {
      const r = await db
        .prepare("SELECT * FROM campaigns WHERE id = ?")
        .bind(id)
        .first<CampaignRow>();
      return r ? toCampaign(r) : null;
    },
    async putCampaign(c) {
      await db
        .prepare(
          `INSERT INTO campaigns (id, name, months, cap, gift, created_at, active)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, cap = excluded.cap,
             active = excluded.active`,
        )
        .bind(c.id, c.name, c.months, c.cap, c.gift ? 1 : 0, c.createdAt, c.active ? 1 : 0)
        .run();
    },
    async given(campaignId) {
      const r = await db
        .prepare("SELECT COUNT(*) AS n FROM codes WHERE campaign_id = ?")
        .bind(campaignId)
        .first<{ n: number }>();
      return r?.n ?? 0;
    },
    async setNote(id, note) {
      const res = await db.prepare("UPDATE codes SET note = ? WHERE id = ?").bind(note, id).run();
      return (res.meta?.changes ?? 0) > 0;
    },
    async grants() {
      return (
        await db
          .prepare("SELECT licence_id, install, label, at FROM grants ORDER BY at DESC")
          .all<{ licence_id: string; install: string; label: string | null; at: string }>()
      ).results.map((g) => ({
        licenceId: g.licence_id,
        install: g.install,
        label: g.label,
        at: g.at,
      }));
    },
    async putGrant(g) {
      await db
        .prepare("INSERT INTO grants (licence_id, install, label, at) VALUES (?, ?, ?, ?)")
        .bind(g.licenceId, g.install, g.label, g.at)
        .run();
    },
  };
}

interface OfferRow {
  campaign_id: string;
  forum_id: string;
  starts_at: string;
  min_age_days: number;
  pinned_thread_id: string | null;
  status_message_id: string | null;
  status_line: string | null;
  active: number;
  hold_minutes: number | null;
  claims_announced: number | null;
  intro_posted: number | null;
  ended_at: string | null;
}
interface EntryRow {
  post_id: string;
  user_id: string;
  user_name: string;
  posted_at: string;
  number: number;
  status: Entry["status"];
  code_id: string | null;
  decided_at: string | null;
  held_until: string | null;
  reason: string | null;
  told_at: string | null;
}

function d1Founder(db: D1Database): FounderStore {
  const toEntry = (r: EntryRow): Entry => ({
    postId: r.post_id,
    userId: r.user_id,
    userName: r.user_name,
    postedAt: r.posted_at,
    number: r.number,
    status: r.status,
    codeId: r.code_id,
    decidedAt: r.decided_at,
    heldUntil: r.held_until ?? null,
    reason: r.reason ?? null,
    toldAt: r.told_at ?? null,
  });
  return {
    async offer() {
      const r = await db.prepare("SELECT * FROM founder_offer WHERE id = 1").first<OfferRow>();
      return r
        ? ({
            campaignId: r.campaign_id,
            forumId: r.forum_id,
            startsAt: r.starts_at,
            minAgeDays: r.min_age_days,
            pinnedThreadId: r.pinned_thread_id,
            statusMessageId: r.status_message_id,
            statusLine: r.status_line,
            active: r.active === 1,
            holdMinutes: r.hold_minutes ?? HOLD_MINUTES,
            claimsAnnounced: r.claims_announced ?? 0,
            introPosted: r.intro_posted === 1,
            endedAt: r.ended_at ?? null,
          } satisfies Offer)
        : null;
    },
    async putOffer(o) {
      await db
        .prepare(
          `INSERT INTO founder_offer (id, campaign_id, forum_id, starts_at, min_age_days,
             pinned_thread_id, status_message_id, status_line, active, hold_minutes,
             claims_announced, intro_posted, ended_at)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET campaign_id = excluded.campaign_id,
             forum_id = excluded.forum_id, starts_at = excluded.starts_at,
             min_age_days = excluded.min_age_days, pinned_thread_id = excluded.pinned_thread_id,
             status_message_id = excluded.status_message_id, status_line = excluded.status_line,
             active = excluded.active, hold_minutes = excluded.hold_minutes,
             claims_announced = excluded.claims_announced, intro_posted = excluded.intro_posted,
             ended_at = excluded.ended_at`,
        )
        .bind(
          o.campaignId,
          o.forumId,
          o.startsAt,
          o.minAgeDays,
          o.pinnedThreadId,
          o.statusMessageId,
          o.statusLine,
          o.active ? 1 : 0,
          o.holdMinutes,
          o.claimsAnnounced,
          o.introPosted ? 1 : 0,
          o.endedAt,
        )
        .run();
    },
    async entries() {
      return (await db.prepare("SELECT * FROM founder_entries").all<EntryRow>()).results.map(
        toEntry,
      );
    },
    async entry(id) {
      const r = await db
        .prepare("SELECT * FROM founder_entries WHERE post_id = ?")
        .bind(id)
        .first<EntryRow>();
      return r ? toEntry(r) : null;
    },
    async putEntry(e) {
      await db
        .prepare(
          `INSERT INTO founder_entries (post_id, user_id, user_name, posted_at, number, status,
             code_id, decided_at, held_until, reason, told_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(post_id) DO UPDATE SET number = excluded.number, status = excluded.status,
             code_id = excluded.code_id, decided_at = excluded.decided_at,
             held_until = excluded.held_until, reason = excluded.reason,
             told_at = excluded.told_at`,
        )
        .bind(
          e.postId,
          e.userId,
          e.userName,
          e.postedAt,
          e.number,
          e.status,
          e.codeId,
          e.decidedAt,
          e.heldUntil,
          e.reason,
          e.toldAt,
        )
        .run();
    },
  };
}

/**
 * What Ember Bot calls on each pass, through its service binding (LICENCE, entrypoint
 * FounderDesk). Only Workers bound to it can call these; nothing here is on the internet.
 */
export class FounderDesk extends WorkerEntrypoint<Bindings> {
  private stores() {
    const store = d1Store(this.env.DB);
    const founder = d1Founder(this.env.DB);
    const capOf = async (id: string) => (await store.campaign(id))?.cap ?? null;
    const codeUsed = async (id: string) => ((await store.codeById(id))?.uses ?? 0) > 0;
    return { store, founder, capOf, codeUsed };
  }
  async view() {
    const { founder, capOf, codeUsed } = this.stores();
    return emberView(founder, capOf, codeUsed, Date.now(), this.env.TEST_FORUM_ID);
  }
  /** Each new post on a pass, in one call (see founder.ts, seePost). */
  async seePosts(posts: PostSeen[]) {
    const { founder, capOf, codeUsed } = this.stores();
    const o = await founder.offer();
    const cap = (o ? await capOf(o.campaignId) : null) ?? 25;
    const now = Date.now();
    const out = [];
    for (const p of posts) out.push(await seePost(founder, cap, p, codeUsed, now));
    return out;
  }
  /** Who still needs to hear why they were turned away. */
  async pending() {
    return pending(this.stores().founder);
  }
  async told(postIds: string[]) {
    await emberTold(this.stores().founder, postIds);
  }
  async wroteStatus(messageId: string, line: string) {
    await emberWroteStatus(this.stores().founder, messageId, line);
  }
  async postedIntro() {
    await emberPostedIntro(this.stores().founder);
  }
  async announced(n: number) {
    const { founder, capOf, codeUsed } = this.stores();
    const o = await founder.offer();
    await emberAnnounced(founder, n, (o ? await capOf(o.campaignId) : null) ?? 25, codeUsed);
  }
}

/** Premium Ember from the private database (null until uploaded). */
async function premiumEmber(db: D1Database): Promise<Picture | null> {
  const row = await db
    .prepare("SELECT type, data_b64 FROM private_assets WHERE name = ?")
    .bind("premium-ember")
    .first<{ type: string; data_b64: string }>()
    .catch(() => null);
  if (!row) return null;
  const bin = atob(row.data_b64);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  return { type: row.type, data: data.buffer };
}

export default {
  async fetch(req: Request, env: Bindings): Promise<Response> {
    try {
      return await handle(req, env, d1Store(env.DB), Date.now, fetch, {
        founder: d1Founder(env.DB),
        ...(env.EMBER ? { ember: env.EMBER } : {}),
        premiumEmber: () => premiumEmber(env.DB),
      });
    } catch {
      return new Response(
        JSON.stringify({ error: "The licence service had a problem. Try again later." }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );
    }
  },
};
