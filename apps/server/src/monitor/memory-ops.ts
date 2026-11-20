import { execFile } from "node:child_process";
import os from "node:os";
import type { JobStepInput } from "@dragon-control/core";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { readMemory, type MemoryService, type MemorySources } from "./memory";

/**
 * The free-memory plan step: close an app on this machine, or free Hearth's voice memory, after
 * the owner approved it (the owner, 2026-11-02: "you press OK and it does it"). Containers are
 * stopped with the stop-container step instead.
 *
 * An app is closed the polite way (Windows asks its windows to close; Linux and macOS send it the
 * signal to quit), so it can ask about unsaved work; Hearth then checks it is gone. Forcing it
 * closed is a separate choice the plan states plainly (unsaved work in it is lost). Only apps of
 * the account Hearth runs as, never the system, networking, shells or Hearth itself: the same
 * rules the breakdown shows, checked again when planning and again right before running.
 */

const fmt = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

export interface MemoryHooks {
  voiceLoaded(): boolean;
  releaseVoice(): void;
}

export class MemoryOperations {
  private hooks: MemoryHooks = { voiceLoaded: () => false, releaseVoice: () => undefined };

  constructor(
    private readonly sources: (hooks: MemoryHooks) => MemorySources,
    private readonly services: () => Promise<MemoryService[]>,
    /** Closes processes; real by default, a stand-in in tests. */
    private readonly close: (pids: number[], force: boolean) => Promise<void> = closeProcesses,
  ) {}

  /** Hearth's voice, once it exists (app.ts). */
  bind(hooks: MemoryHooks) {
    this.hooks = hooks;
  }

  async breakdown() {
    return readMemory(this.sources(this.hooks), await this.services(), os.hostname());
  }

  private refused(label: string, why: string): PlannedStep {
    return {
      label,
      serviceName: "This machine",
      changes: true,
      policy: "refuse",
      policyReason: why,
    };
  }

  /** The app's row as it is now, and the processes still the ones planned. */
  private async app(step: JobStepInput | StepRun) {
    const p = step.params ?? {};
    const key = String(p.app ?? "").toLowerCase();
    const b = await this.breakdown();
    const item = b.items.find((i) => i.id === `app:${key}`);
    let planned: { pid: number; started?: string }[] = [];
    try {
      planned = JSON.parse(String(p.pids ?? "[]")) as typeof planned;
    } catch {
      planned = [];
    }
    const now = item?.stop?.step.params?.pids
      ? (JSON.parse(String(item.stop.step.params.pids)) as { pid: number; started?: string }[])
      : [];
    // The same processes: same pid and the same start time (a reused pid is a different app).
    const still = planned.length
      ? now.filter((n) => planned.some((x) => x.pid === n.pid && x.started === n.started))
      : now;
    return { item, still, name: String(p.name || item?.name || key) };
  }

  async plan(step: JobStepInput): Promise<PlannedStep> {
    const p = step.params ?? {};
    if (p.what === "voice") {
      const label = "Free up Hearth's voice memory";
      if (!this.hooks.voiceLoaded()) return this.refused(label, "Hearth's voice is not loaded.");
      const b = await this.breakdown();
      const mb = b.items.find((i) => i.id === "hearth-voice")?.mb ?? 0;
      return {
        label,
        serviceName: "This machine",
        changes: true,
        policy: "approve-first",
        policyReason: "Memory is freed only with your approval.",
        params: { what: "voice" },
        change: {
          summary: label,
          settings: [
            {
              name: "Hearth voice",
              before: mb ? `loaded, ${fmt(mb)}` : "loaded",
              after: "stopped; it starts again the next time you talk or play a reply",
            },
          ],
        },
      };
    }
    if (p.what !== "app") return this.refused("Free memory", "Say what to free: app or voice.");
    const force = p.force === true || p.force === "true";
    const { item, still, name } = await this.app(step);
    const label = `${force ? "Force close" : "Close"} ${name}`;
    if (!item) return this.refused(label, `${name} is not running.`);
    if (item.keep) return this.refused(label, `${name} stays open: ${item.keep.toLowerCase()}.`);
    if (!still.length) return this.refused(label, `${name} is not running any more.`);
    return {
      label: `${label} (frees about ${fmt(item.mb)})`,
      serviceName: "This machine",
      changes: true,
      policy: "approve-first",
      policyReason: "Apps are closed only with your approval.",
      params: {
        what: "app",
        app: String(p.app).toLowerCase(),
        name,
        pids: JSON.stringify(still),
        ...(force ? { force: true } : {}),
      },
      change: {
        summary: label,
        settings: [
          {
            name,
            before: `running${still.length > 1 ? `, ${still.length} processes` : ""}, ${fmt(item.mb)}`,
            after: force
              ? "closed at once"
              : "closed the normal way (it may ask about unsaved work first)",
          },
          ...(force
            ? [
                {
                  name: "Note",
                  before: "",
                  after: `Unsaved work in ${name} is lost. Close it the normal way first when you can.`,
                },
              ]
            : []),
        ],
      },
    };
  }

  async run(step: StepRun): Promise<StepOutcome> {
    const p = step.params ?? {};
    if (p.what === "voice") {
      if (!this.hooks.voiceLoaded())
        return { ok: true, result: "Hearth's voice was already stopped; nothing to free." };
      this.hooks.releaseVoice();
      return this.hooks.voiceLoaded()
        ? { ok: false, result: "Hearth's voice did not stop." }
        : { ok: true, result: "Hearth's voice memory is freed; it starts again when used." };
    }
    const force = p.force === true || p.force === "true";
    const { item, still, name } = await this.app(step);
    if (!item || !still.length)
      return { ok: true, result: `${name} was already closed. Nothing else was touched.` };
    if (item.keep)
      return { ok: false, stale: true, result: `${name} stays open: ${item.keep.toLowerCase()}.` };
    const pids = still.map((s) => s.pid);
    await this.close(pids, force).catch(() => undefined);
    // Give it a moment to close its windows and save.
    for (let i = 0; i < 20; i++) {
      const left = (await this.app({ ...step, params: { ...p, pids: JSON.stringify(still) } }))
        .still;
      if (!left.length)
        return { ok: true, result: `${name} is closed; about ${fmt(item.mb)} back (checked).` };
      await new Promise((r) => setTimeout(r, 500));
    }
    return {
      ok: false,
      result: force
        ? `${name} did not close.`
        : `${name} is still open: it may be asking about unsaved work. Check it, or ask Ember to force it closed.`,
    };
  }
}

/** Polite close: Windows asks the app's windows to close; elsewhere the quit signal. */
export function closeProcesses(pids: number[], force: boolean): Promise<void> {
  if (process.platform === "win32")
    return new Promise((resolve) =>
      execFile(
        "taskkill",
        [...(force ? ["/F"] : []), ...pids.flatMap((p) => ["/PID", String(p)])],
        { timeout: 15_000, windowsHide: true },
        () => resolve(),
      ),
    );
  for (const pid of pids) {
    try {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  return Promise.resolve();
}
