import { AppUnreachableError, joinUrl, type Fetch } from "./http";

/**
 * A small socket.io client (Engine.IO 4, long-polling only) over Hearth's own fetch, for apps
 * whose API is socket.io events rather than HTTP routes (Uptime Kuma). Polling needs nothing but
 * HTTP, so the same stand-ins that answer Hearth's fetch in tests answer it too.
 *
 * One GET waits for the server's packets at a time, and POSTs go one after another: Engine.IO
 * closes a session whose POSTs overlap. Packets in one body are separated by \x1e. "42[...]" is
 * an event, "42N[...]" an event the sender wants answered, and "43N[...]" that answer.
 */

export type SocketEvent = [name: string, ...args: unknown[]];

const SEP = "\x1e";

export class SocketSession {
  readonly events: SocketEvent[] = [];
  private nextAck = 0;
  private readonly acks = new Map<number, (args: unknown[]) => void>();
  private posting: Promise<unknown> = Promise.resolve();
  private open = true;
  private listeners = new Set<() => void>();
  private reader?: Promise<void>;

  private constructor(
    private readonly fetchImpl: Fetch,
    private readonly url: (sid?: string) => string,
    private readonly sid: string,
    private readonly name: string,
  ) {}

  /** Opens a session and connects to the main namespace. */
  static async connect(
    fetchImpl: Fetch,
    base: string,
    name: string,
    path = "/socket.io/",
  ): Promise<SocketSession> {
    const url = (sid?: string) =>
      joinUrl(base, `${path}?EIO=4&transport=polling${sid ? `&sid=${sid}` : ""}&t=${Date.now()}`);
    let text: string;
    try {
      const res = await fetchImpl(url(), { headers: {}, signal: AbortSignal.timeout(8000) });
      text = (await res.text?.()) ?? "";
      if (!res.ok) throw new Error(`it answered ${res.status}`);
    } catch (error) {
      throw new AppUnreachableError(
        `${name} did not answer at ${base}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let sid: string | undefined;
    try {
      sid = (JSON.parse(text.slice(1)) as { sid?: string }).sid;
    } catch {
      sid = undefined;
    }
    if (!text.startsWith("0") || !sid)
      throw new AppUnreachableError(`${name} at ${base} did not open a socket: is this ${name}?`);
    const s = new SocketSession(fetchImpl, url, sid, name);
    await s.post("40");
    s.reader = s.read();
    return s;
  }

  private post(body: string): Promise<void> {
    const next = this.posting.then(async () => {
      if (!this.open) return;
      const res = await this.fetchImpl(this.url(this.sid), {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new AppUnreachableError(`${this.name} closed the socket.`);
    });
    this.posting = next.catch(() => undefined);
    return next;
  }

  private async read() {
    while (this.open) {
      let text: string;
      try {
        const res = await this.fetchImpl(this.url(this.sid), {
          headers: {},
          signal: AbortSignal.timeout(40_000),
        });
        if (!res.ok) break;
        text = (await res.text?.()) ?? "";
      } catch {
        break;
      }
      for (const p of text.split(SEP)) this.packet(p);
      for (const f of this.listeners) f();
    }
    this.open = false;
    for (const f of this.listeners) f();
  }

  private packet(p: string) {
    if (p === "2") {
      void this.post("3").catch(() => undefined);
      return;
    }
    if (p === "1") {
      this.open = false;
      return;
    }
    const ack = /^43(\d+)([\s\S]*)$/.exec(p);
    if (ack) {
      const done = this.acks.get(Number(ack[1]));
      this.acks.delete(Number(ack[1]));
      try {
        done?.(JSON.parse(ack[2]!) as unknown[]);
      } catch {
        done?.([]);
      }
      return;
    }
    const ev = /^42(\d*)([\s\S]*)$/.exec(p);
    if (!ev) return;
    try {
      this.events.push(JSON.parse(ev[2]!) as SocketEvent);
    } catch {
      /* A packet that is not JSON is not one Hearth reads. */
    }
  }

  /** Sends an event without waiting for an answer. */
  send(name: string, ...args: unknown[]): Promise<void> {
    return this.post(`42${JSON.stringify([name, ...args])}`);
  }

  /** Sends an event and waits for the server's answer (its first argument). */
  async ask<T>(name: string, args: unknown[], timeoutMs = 15_000): Promise<T> {
    const id = this.nextAck++;
    const answer = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.acks.delete(id);
        reject(new AppUnreachableError(`${this.name} did not answer ${name} in time.`));
      }, timeoutMs);
      this.acks.set(id, (r) => {
        clearTimeout(timer);
        resolve(r[0] as T);
      });
    });
    await this.post(`42${id}${JSON.stringify([name, ...args])}`);
    return answer;
  }

  /** Waits until done() holds (checked as packets arrive), or the time is up. */
  waitFor(done: () => boolean, timeoutMs: number): Promise<boolean> {
    if (done()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(ok);
      };
      const check = () => {
        if (done()) finish(true);
        else if (!this.open) finish(false);
      };
      const timer = setTimeout(() => finish(done()), timeoutMs);
      this.listeners.add(check);
    });
  }

  /** The events of one name received so far. */
  all(name: string): unknown[][] {
    return this.events.filter((e) => e[0] === name).map((e) => e.slice(1));
  }

  /** Leaves the namespace and closes the session; the waiting GET then returns. */
  async close() {
    if (!this.open) return;
    await this.post(`41${SEP}1`).catch(() => undefined);
    this.open = false;
    await Promise.race([this.reader, new Promise((r) => setTimeout(r, 1000))]);
  }
}
