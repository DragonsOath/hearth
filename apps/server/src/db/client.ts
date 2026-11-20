import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { migrate } from "drizzle-orm/sqlite-proxy/migrator";
import * as schema from "./schema";

/**
 * Node's built-in node:sqlite, wired through drizzle's sqlite-proxy driver
 * (drizzle has no first-party node:sqlite driver). Avoids native modules
 * entirely, so the same build runs on Windows, Linux, amd64 and arm64.
 */
export function openDatabase(file: string) {
  if (file !== ":memory:") {
    // Owner-only on Linux and macOS: the folder, and the database (SQLite gives
    // its -wal and -shm companions the same permissions). Windows ignores modes.
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (!existsSync(file)) writeFileSync(file, "", { mode: 0o600 });
  }

  const sqlite = new DatabaseSync(file);
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");

  const db = drizzle(
    async (sqlText, params, method) => {
      const stmt = sqlite.prepare(sqlText);
      const bound = params as SQLInputValue[];

      if (method === "run") {
        stmt.run(...bound);
        return { rows: [] };
      }
      if (method === "get") {
        const row = stmt.get(...bound) as Record<string, unknown> | undefined;
        // Drizzle's proxy treats `rows: undefined` as "no row". An empty array
        // would be mapped as a row of undefined columns (and crash JSON columns).
        return { rows: row ? Object.values(row) : undefined } as unknown as { rows: unknown[] };
      }
      const rows = stmt.all(...bound) as Record<string, unknown>[];
      return { rows: rows.map((row) => Object.values(row)) };
    },
    { schema },
  );

  return { db, sqlite, close: () => sqlite.close() };
}

export type DbHandle = ReturnType<typeof openDatabase>;
export type Database = DbHandle["db"];

export async function runMigrations(
  handle: ReturnType<typeof openDatabase>,
  migrationsFolder: string,
): Promise<void> {
  // SQLite's documented procedure for schema changes that rebuild tables
  // (https://sqlite.org/lang_altertable.html#otheralter): foreign keys must be
  // off *outside* the transaction, because PRAGMA foreign_keys is a no-op
  // inside one. Otherwise DROP TABLE fires ON DELETE CASCADE and silently
  // wipes child rows (e.g. service dependencies) during an upgrade.
  handle.sqlite.exec("PRAGMA foreign_keys = OFF;");
  try {
    await migrate(
      handle.db,
      async (queries) => {
        handle.sqlite.exec("BEGIN");
        try {
          for (const query of queries) handle.sqlite.exec(query);
          const violations = handle.sqlite.prepare("PRAGMA foreign_key_check").all();
          if (violations.length) {
            throw new Error(
              `Migration would leave ${violations.length} broken references: ${JSON.stringify(violations.slice(0, 5))}`,
            );
          }
          handle.sqlite.exec("COMMIT");
        } catch (error) {
          handle.sqlite.exec("ROLLBACK");
          throw error;
        }
      },
      { migrationsFolder },
    );
  } finally {
    handle.sqlite.exec("PRAGMA foreign_keys = ON;");
  }
}
