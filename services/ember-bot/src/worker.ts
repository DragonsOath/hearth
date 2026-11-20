import { WorkerEntrypoint } from "cloudflare:workers";
import { cheerNewPosts, handleInteraction, registerCommands, type Env } from "./ember.ts";
import {
  founderPass,
  reminderLine,
  sendFounderCode,
  tellDenied,
  type Denial,
  type FounderDesk,
} from "./founder.ts";
import { sendCode, type Picture } from "./gift.ts";

/**
 * Ember Bot on Cloudflare Workers. Discord calls fetch() for slash commands; the cron trigger
 * (wrangler.toml) calls scheduled() every five minutes to cheer on new around-the-fire posts, and
 * once an hour also refreshes the slash commands, so a new command appears without a manual step.
 */
interface ScheduledEvent {
  scheduledTime: number;
}

interface Bindings extends Env {
  /** The licence service's FounderDesk (service binding): the Founder offer's record. */
  LICENCE?: FounderDesk;
}

/**
 * What the licence service calls to DM a code: a Founder approval, or Send with Ember (its EMBER
 * binding).
 * Reachable only through that binding, never from the internet.
 */
export class EmberDesk extends WorkerEntrypoint<Bindings> {
  async sendFounderCode(a: {
    userId: string;
    postId: string;
    code: string;
    hold?: string;
    picture?: Picture | null;
  }) {
    return sendFounderCode(this.env, (input, init) => fetch(input, init), a);
  }
  /** The owner rejected a Founder post on his code page: she tells them his reason. */
  async tellFounder(a: { userId: string; postId: string; denial: Denial }) {
    return tellDenied(this.env, (input, init) => fetch(input, init), a);
  }
  /** "Send with Ember" on the owner's code page: a code, DMed by Discord name. */
  async sendCode(a: { to: string; code: string; months: number | null; picture?: Picture | null }) {
    return sendCode(this.env, (input, init) => fetch(input, init), a);
  }
}

export default {
  async fetch(req: Request, env: Bindings): Promise<Response> {
    if (req.method === "POST") return handleInteraction(req, env);
    return new Response("Ember is here. 🔥");
  },

  async scheduled(event: ScheduledEvent, env: Bindings): Promise<void> {
    const f = (input: string, init?: RequestInit) => fetch(input, init);
    if (new Date(event.scheduledTime).getUTCMinutes() < 5) await registerCommands(env, f);
    // The Founder offer first, so a counted post gets one reply with its number.
    if (env.LICENCE) {
      try {
        await founderPass(env, env.LICENCE, f);
        // Once a day at 18:00 UTC (10 AM Pacific): screenshots still waiting, to the owner only.
        const at = new Date(event.scheduledTime);
        if (at.getUTCHours() === 18 && at.getUTCMinutes() < 5 && env.QUEUE_ID) {
          const v = await env.LICENCE.view();
          if (v.active && (v.waiting ?? 0) > 0)
            await f(`https://discord.com/api/v10/channels/${env.QUEUE_ID}/messages`, {
              method: "POST",
              headers: {
                authorization: `Bot ${env.BOT_TOKEN}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                content: reminderLine(v.waiting ?? 0),
                allowed_mentions: { parse: [] },
              }),
            });
        }
      } catch {
        // The licence service or Discord had a problem: the usual cheer still runs.
      }
    }
    await cheerNewPosts(env, f, event.scheduledTime);
  },
};
