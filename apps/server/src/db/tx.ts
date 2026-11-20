import type { DbHandle } from "./client";

/**
 * Serialises transactions. node:sqlite is synchronous, but drizzle's proxy
 * API is async, so two requests could otherwise interleave statements
 * inside one BEGIN/COMMIT. A promise chain keeps them strictly in order.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Diagnostics only (DC_TX_DEBUG=<file>): one transaction held open for long blocks every write
 * after it, so what holds the queue, and what waits on it, are written to that file.
 */
const debugFile = process.env.DC_TX_DEBUG;
let holder: { at: number; stack: string; told?: boolean } | undefined;
const waiting = new Set<{ at: number; stack: string; told?: boolean }>();
if (debugFile) {
  void import("node:fs").then((fs) =>
    fs.appendFileSync(debugFile, `${new Date().toISOString()} tx debug on (pid ${process.pid})\n`),
  );
  const timer = setInterval(() => {
    const now = Date.now();
    const lines: string[] = [];
    if (holder && !holder.told && now - holder.at > 10_000) {
      holder.told = true;
      lines.push(`held ${Math.round((now - holder.at) / 1000)}s, started at:\n${holder.stack}`);
    }
    for (const w of waiting)
      if (!w.told && now - w.at > 10_000) {
        w.told = true;
        lines.push(
          `waiting ${Math.round((now - w.at) / 1000)}s:\n${w.stack}\nheld by:\n${holder?.stack ?? "(nothing holds it: the queue itself is stuck)"}`,
        );
      }
    if (lines.length)
      void import("node:fs").then((fs) =>
        fs.appendFileSync(debugFile, `${new Date().toISOString()} ${lines.join("\n\n")}\n\n`),
      );
  }, 2000);
  timer.unref?.();
}

function enqueue<T>(fn: () => Promise<T> | T): Promise<T> {
  const me = debugFile ? { at: Date.now(), stack: new Error().stack ?? "" } : undefined;
  if (me) waiting.add(me);
  const run = queue.then(async () => {
    if (me) {
      waiting.delete(me);
      holder = { at: Date.now(), stack: me.stack };
    }
    try {
      return await fn();
    } finally {
      if (me) holder = undefined;
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

export function withTransaction<T>(handle: DbHandle, fn: () => Promise<T>): Promise<T> {
  return enqueue(async () => {
    handle.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn();
      handle.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      handle.sqlite.exec("ROLLBACK");
      throw error;
    }
  });
}

/**
 * Runs outside any transaction but in the same queue, for statements that
 * must not run while one is open (VACUUM INTO for backups).
 */
export function withQueue<T>(fn: () => Promise<T> | T): Promise<T> {
  return enqueue(fn);
}
