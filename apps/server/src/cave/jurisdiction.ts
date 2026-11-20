import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import {
  homelabMatcher,
  type JurisdictionEntry,
  type JurisdictionKind,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { withTransaction } from "../db/tx";
import { recordAudit } from "../store/audit";
import { InvalidRequestError, NotFoundError } from "../store/errors";

/**
 * What Ember looks after. Everything Hearth watches is in
 * scope by definition; entries add what it does not watch yet (another
 * machine, a repository, a folder, a domain) and name what is out of scope
 * even when it lives on a homelab machine. The decision is about the purpose
 * of a request, not where its files are.
 *
 * Enforced in layers: requests clearly out of scope are declined before any
 * AI is asked (and before any usage); the AI is told the jurisdiction and
 * declines the rest; and whatever it asks for still has to resolve to
 * something Hearth manages, under your autonomy rules.
 */

type Row = typeof t.jurisdiction.$inferSelect;

const toEntry = (r: Row): JurisdictionEntry => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  value: r.value ?? undefined,
  access: r.access,
  note: r.note ?? undefined,
  createdAt: r.createdAt,
});

export interface ScopeVerdict {
  /** in: about the homelab. out: declined. unsure: left to the AI, with the rules. */
  verdict: "in" | "out" | "unsure";
  reason: string;
  /** The out-of-scope entry that decided it, if any. */
  matched?: JurisdictionEntry;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, phrase: string) =>
  phrase.trim().length >= 3 &&
  new RegExp(`(^|[^a-z0-9])${escape(phrase.toLowerCase().trim())}($|[^a-z0-9])`).test(
    text.toLowerCase(),
  );

/**
 * Decides whether a request is for Ember. `vocabulary` holds the
 * names Hearth knows (machines, services, projects). A follow-up in
 * an ongoing conversation gets the benefit of the doubt unless it names
 * something out of scope.
 */
export function scopeCheck(
  text: string,
  entries: JurisdictionEntry[],
  vocabulary: string[],
  opts: { followUp?: boolean } = {},
): ScopeVerdict {
  const inside = entries.filter((e) => e.access === "in");
  const outside = entries.filter((e) => e.access === "out");
  const homelab = homelabMatcher([
    ...vocabulary,
    ...inside.flatMap((e) => [e.name, ...(e.value ? [e.value] : [])]),
  ])(text);
  const excluded = outside.find(
    (e) => mentions(text, e.name) || (e.value ? mentions(text, e.value) : false),
  );
  if (excluded && !homelab) {
    return {
      verdict: "out",
      reason: `${excluded.name} is outside what Ember looks after${excluded.note ? ` (${excluded.note})` : ""}.`,
      matched: excluded,
    };
  }
  if (excluded) {
    // "Is the Gig Tracker container healthy?" may be hosting (in) or development (out).
    return {
      verdict: "unsure",
      reason: `Mentions ${excluded.name}, which is out of scope, together with the homelab.`,
      matched: excluded,
    };
  }
  if (homelab) return { verdict: "in", reason: "About the homelab." };
  if (opts.followUp) return { verdict: "in", reason: "A follow-up in a homelab conversation." };
  return { verdict: "unsure", reason: "No homelab terms; the AI decides with the rules." };
}

/** The jurisdiction in words, for the AI's instructions. */
export function jurisdictionText(entries: JurisdictionEntry[]): string {
  const line = (e: JurisdictionEntry) =>
    `- ${e.name}${e.value ? ` (${e.value})` : ""}${e.note ? `: ${e.note}` : ""}`;
  const inside = entries.filter((e) => e.access === "in");
  const outside = entries.filter((e) => e.access === "out");
  return [
    "You look after this homelab: every machine and service Hearth watches, plus:",
    inside.length ? inside.map(line).join("\n") : "- nothing else.",
    ...(outside.length
      ? [
          "The owner noted these are not part of the homelab (context only, never a reason to refuse):",
          outside.map(line).join("\n"),
        ]
      : []),
    "Answer anything the owner asks, like any capable assistant: general questions, facts, lists, explanations, research and advice are all welcome. Never decline a question as off-topic. Say which parts are general knowledge and which you checked on this homelab, and connect it to the homelab when it helps (for example, a list of a show's specials, then which ones the owner's library already has and an offer to get the rest).",
  ].join("\n");
}

export class Jurisdiction {
  constructor(private readonly handle: DbHandle) {}

  async list(): Promise<JurisdictionEntry[]> {
    return (
      await this.handle.db
        .select()
        .from(t.jurisdiction)
        .orderBy(asc(t.jurisdiction.access), asc(t.jurisdiction.name))
    ).map(toEntry);
  }

  async add(
    input: {
      kind: JurisdictionKind;
      name: string;
      value?: string;
      access: "in" | "out";
      note?: string;
    },
    actor: "you" | "machine" = "you",
  ): Promise<JurisdictionEntry> {
    const name = input.name.trim();
    if (!name) throw new InvalidRequestError("Give it a name.");
    const row: Row = {
      id: randomUUID(),
      kind: input.kind,
      name,
      value: input.value?.trim() || null,
      access: input.access,
      note: input.note?.trim() || null,
      createdAt: new Date().toISOString(),
    };
    await withTransaction(this.handle, async () => {
      await this.handle.db.insert(t.jurisdiction).values(row);
      await recordAudit(this.handle.db, {
        actor: "you",
        action: `${input.access === "in" ? "Added to" : "Excluded from"} Ember's jurisdiction: ${name}`,
        target: "jurisdiction",
        detail: { kind: input.kind, ...(row.note ? { note: row.note } : {}), via: actor },
      });
    });
    return toEntry(row);
  }

  async remove(id: string): Promise<void> {
    await withTransaction(this.handle, async () => {
      const row = await this.handle.db
        .select()
        .from(t.jurisdiction)
        .where(eq(t.jurisdiction.id, id))
        .get();
      if (!row) throw new NotFoundError("No such entry.");
      await this.handle.db.delete(t.jurisdiction).where(eq(t.jurisdiction.id, id));
      await recordAudit(this.handle.db, {
        actor: "you",
        action: `Removed from Ember's jurisdiction list: ${row.name}`,
        target: "jurisdiction",
      });
    });
  }
}
