import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ATTACHMENT_LIMITS as L,
  type CaptureContext,
  type CaveAttachment,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { redactTranscript } from "../memory/redact";
import { InvalidRequestError, NotFoundError } from "../store/errors";

/**
 * Images you attach to a message to Ember (feature request 19). Stored here only: an image
 * reaches the AI provider when Ember looks at it (view_attachment) while answering the
 * message it was sent with, never before you send, never from another conversation.
 */

type Row = typeof t.attachments.$inferSelect;

type Mime = "image/png" | "image/jpeg" | "image/webp";

/** The file really is the image type it claims (by its first bytes). */
function sniff(buf: Buffer): Mime | undefined {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf.length > 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return undefined;
}

const text = (max: number) => z.string().max(max);

export const captureContext = z
  .object({
    mode: z.enum(["panel", "item", "region", "upload", "screen"]),
    fileName: text(200).optional(),
    serviceId: text(200).optional(),
    serviceName: text(200).optional(),
    panel: text(200).optional(),
    tab: text(60).optional(),
    item: text(300).optional(),
    metrics: z.array(text(120)).max(40).optional(),
    capturedAt: z.string().max(40),
    redacted: z.number().int().min(0).max(10_000),
    region: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite(),
        height: z.number().finite(),
      })
      .strict()
      .optional(),
  })
  .strict();

export function toAttachment(r: Omit<Row, "data">): CaveAttachment {
  return {
    id: r.id,
    mime: r.mime,
    width: r.width,
    height: r.height,
    sizeBytes: r.sizeBytes,
    context: r.context as CaptureContext,
    createdAt: r.createdAt,
  };
}

/** One line for the AI: what the capture shows, as recorded when it was taken. */
export function describeCapture(a: CaveAttachment): string {
  const c = a.context;
  if (c.mode === "upload")
    return `attachment ${a.id}: a photo you attached${c.fileName ? ` ("${c.fileName}")` : ""}, added ${c.capturedAt.slice(0, 16).replace("T", " ")} UTC`;
  if (c.mode === "screen")
    return [
      `attachment ${a.id}: the whole Hearth screen`,
      c.panel ? `on the ${c.panel} page` : "",
      c.metrics?.length ? `showing ${c.metrics.slice(0, 12).join(", ")}` : "",
      `captured ${c.capturedAt.slice(0, 16).replace("T", " ")} UTC`,
      c.redacted ? `${c.redacted} sensitive element(s) left out` : "",
    ]
      .filter(Boolean)
      .join(", ");
  const what =
    c.mode === "region"
      ? "a region of the screen"
      : c.mode === "item"
        ? `an item${c.item ? ` ("${c.item}")` : ""}`
        : "a whole panel";
  return [
    `attachment ${a.id}: ${what}`,
    c.panel ? `in the ${c.panel} panel${c.tab ? ` (${c.tab} tab)` : ""}` : "",
    c.metrics?.length ? `showing ${c.metrics.slice(0, 12).join(", ")}` : "",
    `captured ${c.capturedAt.slice(0, 16).replace("T", " ")} UTC`,
    c.redacted ? `${c.redacted} sensitive element(s) left out` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

const COLUMNS = {
  id: t.attachments.id,
  conversationId: t.attachments.conversationId,
  messageId: t.attachments.messageId,
  mime: t.attachments.mime,
  width: t.attachments.width,
  height: t.attachments.height,
  sizeBytes: t.attachments.sizeBytes,
  context: t.attachments.context,
  createdAt: t.attachments.createdAt,
};

export class Attachments {
  constructor(private readonly handle: DbHandle) {}

  private get db() {
    return this.handle.db;
  }

  async create(input: {
    data: string;
    width: number;
    height: number;
    context: unknown;
  }): Promise<CaveAttachment> {
    const buf = Buffer.from(input.data, "base64");
    if (!buf.length) throw new InvalidRequestError("The image is empty.");
    if (buf.length > L.maxBytes)
      throw new InvalidRequestError(
        `The image is ${(buf.length / 1048576).toFixed(1)} MB; the most is ${L.maxBytes / 1048576} MB. Capture a smaller area.`,
      );
    const mime = sniff(buf);
    if (!mime) throw new InvalidRequestError("Only PNG, JPEG, or WebP images can be attached.");
    const context = captureContext.parse(input.context) as CaptureContext;
    // Text recorded with it is checked like any message: no secrets kept.
    if (context.item) context.item = redactTranscript(context.item);
    if (context.metrics) context.metrics = context.metrics.map(redactTranscript);
    await this.prune();
    const total =
      (
        await this.db
          .select({ n: sql<number>`coalesce(sum(${t.attachments.sizeBytes}), 0)` })
          .from(t.attachments)
          .get()
      )?.n ?? 0;
    if (total + buf.length > L.totalBytes)
      throw new InvalidRequestError(
        `Attached images already use ${Math.round(total / 1048576)} MB of the ${L.totalBytes / 1048576} MB limit. Delete old conversations to make room.`,
      );
    const row: Row = {
      id: randomUUID(),
      conversationId: null,
      messageId: null,
      mime,
      data: buf,
      width: Math.max(1, Math.round(input.width)),
      height: Math.max(1, Math.round(input.height)),
      sizeBytes: buf.length,
      context,
      createdAt: new Date().toISOString(),
    };
    await this.db.insert(t.attachments).values(row);
    return toAttachment(row);
  }

  async meta(id: string): Promise<Omit<Row, "data">> {
    const r = await this.db
      .select(COLUMNS)
      .from(t.attachments)
      .where(eq(t.attachments.id, id))
      .get();
    if (!r) throw new NotFoundError("That image is gone.");
    return r;
  }

  async bytes(id: string): Promise<{ mime: string; data: Buffer }> {
    const r = await this.db
      .select({ mime: t.attachments.mime, data: t.attachments.data })
      .from(t.attachments)
      .where(eq(t.attachments.id, id))
      .get();
    if (!r) throw new NotFoundError("That image is gone.");
    return { mime: r.mime, data: Buffer.from(r.data) };
  }

  /** Not sent yet: removed. Once sent, it stays with its message (deleted with the conversation). */
  async remove(id: string): Promise<void> {
    const r = await this.meta(id);
    if (r.messageId !== null)
      throw new InvalidRequestError(
        "This image was sent with a message; it stays with that conversation.",
      );
    await this.db.delete(t.attachments).where(eq(t.attachments.id, id));
  }

  /** Sending: the images join your message. Only unsent ones, at most ATTACHMENT_LIMITS.perMessage. */
  async validate(ids: string[]): Promise<void> {
    if (ids.length > L.perMessage)
      throw new InvalidRequestError(`At most ${L.perMessage} images per message.`);
    for (const id of ids) {
      const r = await this.meta(id);
      if (r.messageId !== null) throw new InvalidRequestError("That image was already sent.");
    }
  }

  async link(ids: string[], conversationId: string, messageId: number): Promise<void> {
    if (!ids.length) return;
    await this.db
      .update(t.attachments)
      .set({ conversationId, messageId })
      .where(and(inArray(t.attachments.id, ids), isNull(t.attachments.messageId)));
  }

  /** Every sent image of a conversation, by message. */
  async forConversation(conversationId: string): Promise<Map<number, CaveAttachment[]>> {
    const rows = await this.db
      .select(COLUMNS)
      .from(t.attachments)
      .where(eq(t.attachments.conversationId, conversationId));
    const out = new Map<number, CaveAttachment[]>();
    for (const r of rows) {
      if (r.messageId === null) continue;
      out.set(r.messageId, [...(out.get(r.messageId) ?? []), toAttachment(r)]);
    }
    return out;
  }

  /** Captures never sent are cleared after ATTACHMENT_LIMITS.unsentHours. */
  async prune(now = Date.now()): Promise<number> {
    const before = new Date(now - L.unsentHours * 3_600_000).toISOString();
    const stale = await this.db
      .select({ id: t.attachments.id })
      .from(t.attachments)
      .where(and(isNull(t.attachments.messageId), lt(t.attachments.createdAt, before)));
    if (stale.length)
      await this.db.delete(t.attachments).where(
        inArray(
          t.attachments.id,
          stale.map((s) => s.id),
        ),
      );
    return stale.length;
  }
}

/** Session only: access keys never reach these (they are not on any key's allowlist). */
export function registerAttachmentRoutes(app: FastifyInstance, attachments: Attachments) {
  app.post(
    "/api/attachments",
    // A 5 MB image is about 6.7 MB as base64.
    { bodyLimit: Math.ceil(L.maxBytes * 1.4) + 64 * 1024 },
    async (request) => {
      const body = z
        .object({
          data: z.string().min(1),
          width: z.number().int().min(1).max(20_000),
          height: z.number().int().min(1).max(20_000),
          context: z.unknown(),
        })
        .strict()
        .parse(request.body);
      return attachments.create(body);
    },
  );
  app.get<{ Params: { id: string } }>("/api/attachments/:id", async (request, reply) => {
    const { mime, data } = await attachments.bytes(request.params.id);
    return reply
      .header("content-type", mime)
      .header("cache-control", "private, max-age=86400")
      .header("x-content-type-options", "nosniff")
      .send(data);
  });
  app.delete<{ Params: { id: string } }>("/api/attachments/:id", async (request, reply) => {
    await attachments.remove(request.params.id);
    return reply.code(204).send();
  });
}
