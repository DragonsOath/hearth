// The one piece of Cloudflare's runtime this Worker uses (no extra package needed to build).
declare module "cloudflare:workers" {
  export class WorkerEntrypoint<E = unknown> {
    protected env: E;
    protected ctx: unknown;
    constructor(ctx: unknown, env: E);
  }
}
