import { fileQueued, route, type Env } from "./intake.ts";

/**
 * Hearth's panel submission service on Cloudflare Workers (see README.md). fetch() accepts
 * submissions and answers with signed receipts; the scheduled job files the pull requests.
 */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return route(req, env);
  },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    await fileQueued(env, (input, init) => fetch(input, init));
  },
};
