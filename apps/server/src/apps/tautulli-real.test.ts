import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import type { Fetch } from "./http";
import { tautulliCmd } from "./tautulli";
import { TautulliControl } from "./tautulli-control";
import { readTautulliView, type TautulliRead } from "./tautulli-panel";

/**
 * The Tautulli panel's tabs and changes against a real, disposable Tautulli 2.18 (tautulli-test,
 * watching the test Plex; checklist 46.10p). Skipped unless HEARTH_TAUTULLI_TEST_URL and
 * HEARTH_TAUTULLI_TEST_KEY_FILE point at such an instance: never run this against one anyone uses.
 * Every change is put back. The test Plex has no players, so there are no plays to delete: play
 * record deletion is tested on the stand-in.
 */

const url = process.env.HEARTH_TAUTULLI_TEST_URL;
const keyFile = process.env.HEARTH_TAUTULLI_TEST_KEY_FILE;
const key = keyFile ? readFileSync(keyFile, "utf8").trim() : "";
const live = Boolean(url && key);
const f = ((u: string, init: Parameters<typeof fetch>[1]) => fetch(u, init)) as unknown as Fetch;
const broker = {
  use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: key }),
} as unknown as CredentialBroker;
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const svc = { id: "tt-test", name: "Test Tautulli", localUrl: url ?? "" };
const ops = new TautulliControl(handle, broker, f);
const read: TautulliRead = (cmd, p) => tautulliCmd(f, url!, key, cmd, p);
const act = async (params: StepParams) => {
  const planned = await ops.plan(svc, params, base);
  return ops.run(
    {
      kind: "app-tautulli-control",
      serviceId: "tt-test",
      requestedBy: "you",
      params: planned.params,
    },
    svc,
  );
};

describe.skipIf(!live)("Tautulli panel against a real test instance", () => {
  it("reads history, people, a person, libraries, plays per day and its log without keys", async () => {
    const h = await readTautulliView(read, "history", {});
    expect(Array.isArray(h.entries)).toBe(true);
    const users = (await readTautulliView(read, "users", {})).users as { id: number }[];
    expect(users.length).toBeGreaterThan(0);
    const one = await readTautulliView(read, "user", { id: String(users[0]!.id) });
    expect((one.watchTime as unknown[]).length).toBe(4);
    const libs = (await readTautulliView(read, "libraries", {})).libraries as { type: string }[];
    expect(libs.map((l) => l.type).sort()).toEqual(["movie", "show"]);
    const g = await readTautulliView(read, "graphs", { days: "7" });
    expect((g.dates as string[]).length).toBe(7);
    const logs = await readTautulliView(read, "logs", {});
    expect(JSON.stringify(logs).includes(key)).toBe(false);
  });

  it("renames a person and back, keeping their other settings", async () => {
    const users = (await readTautulliView(read, "users", {})).users as { id: number }[];
    const id = String(users[0]!.id);
    const before = await readTautulliView(read, "user", { id });
    const on = await act({
      op: "edit-user",
      userId: id,
      body: JSON.stringify({ friendlyName: "Hearth test person" }),
    });
    expect(on.ok, on.result).toBe(true);
    const mid = await readTautulliView(read, "user", { id });
    expect(mid).toMatchObject({
      name: "Hearth test person",
      keepHistory: before.keepHistory,
      allowGuest: before.allowGuest,
    });
    const back = await act({
      op: "edit-user",
      userId: id,
      body: JSON.stringify({ friendlyName: before.name }),
    });
    expect(back.ok, back.result).toBe(true);
  });

  it("stops and restarts recording a library's plays, and backs up the database", async () => {
    const libs = (await readTautulliView(read, "libraries", {})).libraries as {
      id: number;
      keepHistory: boolean;
    }[];
    const l = libs[0]!;
    const off = await act({
      op: "edit-library",
      libraryId: String(l.id),
      body: JSON.stringify({ keepHistory: !l.keepHistory }),
    });
    expect(off.ok, off.result).toBe(true);
    const back = await act({
      op: "edit-library",
      libraryId: String(l.id),
      body: JSON.stringify({ keepHistory: l.keepHistory }),
    });
    expect(back.ok, back.result).toBe(true);
    const backup = await act({ op: "backup-db" });
    expect(backup.ok, backup.result).toBe(true);
  });
});
