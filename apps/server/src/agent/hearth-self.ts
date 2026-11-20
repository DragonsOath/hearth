import type { JobStepInput, SettingChange } from "@dragon-control/core";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { EMBER_PLAN_SECRET, EMBER_SECRET, planRefusal } from "./hearth-api";

/**
 * The hearth-api-call plan step: Ember changing Hearth itself (settings, services,
 * notifications...) only after the owner approved the exact change (agent/hearth-api.ts has the
 * rules). Planning reads the place first and shows each field's before and after; running checks
 * the rules again, makes the request inside the process, and reads the place back.
 */

export type HearthCall = (
  secret: string,
  req: { method: string; path: string; body?: string },
) => Promise<{ status: number; body: unknown }>;

const show = (v: unknown) => {
  if (v === undefined) return "(not set)";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 200)}...` : s;
};

const READ_FROM: Record<string, string> = { "/api/settings": "/api/workspace" };

export class HearthSelf {
  private call?: HearthCall;
  private methods?: (path: string) => string[];

  /**
   * Hearth's own request handler, once the server exists (app.ts), and the methods each of its
   * addresses takes (so a plan is never offered for a request Hearth has no route for).
   */
  bind(call: HearthCall, methods?: (path: string) => string[]) {
    this.call = call;
    this.methods = methods;
  }

  /** Where a change can be read: settings are part of the workspace answer. */
  private read(path: string) {
    const where = READ_FROM[path.split("?")[0]!] ?? path;
    return this.call!(EMBER_SECRET, { method: "GET", path: where }).catch(() => undefined);
  }

  private request(step: JobStepInput | StepRun) {
    const p = step.params ?? {};
    const method = String(p.method ?? "").toUpperCase();
    const path = String(p.path ?? "");
    const body = typeof p.body === "string" && p.body ? p.body : undefined;
    const why = typeof p.why === "string" ? p.why : "";
    return { method, path, body, why };
  }

  async plan(step: JobStepInput): Promise<PlannedStep> {
    const r = this.request(step);
    const label = r.why.trim()
      ? `Change Hearth: ${r.why.trim().slice(0, 160)}`
      : `Change Hearth: ${r.method} ${r.path.split("?")[0]}`;
    const base = { label, serviceName: "Hearth", changes: true };
    if (!this.call)
      return {
        ...base,
        policy: "refuse",
        policyReason: "Changing Hearth itself is not available here.",
      };
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(r.method))
      return {
        ...base,
        policy: "refuse",
        policyReason: "params.method must be POST, PUT, PATCH or DELETE.",
      };
    const refused = planRefusal(r.method, r.path, r.body);
    if (refused) return { ...base, policy: "refuse", policyReason: refused };
    // A request Hearth has no route for is refused now, not after the owner approved it (11-15:
    // a PATCH on a saved home row, which only takes PUT and DELETE, was approved and then 404'd).
    const takes = this.methods?.(r.path);
    if (takes && !takes.includes(r.method))
      return {
        ...base,
        policy: "refuse",
        policyReason: takes.length
          ? `Hearth has no ${r.method} at ${r.path.split("?")[0]}. That address takes ${takes.join(", ")}.`
          : `Hearth has no address ${r.path.split("?")[0]}. hearth_help names each feature's addresses.`,
      };
    let fields: Record<string, unknown> | undefined;
    if (r.body) {
      try {
        const parsed = JSON.parse(r.body) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          fields = parsed as Record<string, unknown>;
      } catch {
        return { ...base, policy: "refuse", policyReason: "params.body is not valid JSON." };
      }
    }
    // What it says now, so the owner approves the exact before and after.
    const now = await this.read(r.path);
    const current =
      now &&
      now.status < 400 &&
      now.body &&
      typeof now.body === "object" &&
      !Array.isArray(now.body)
        ? (now.body as Record<string, unknown>)
        : undefined;
    // Watching a system or not, in plain words (the owner sees what it does, not a route).
    const sys = /^\/api\/services\/([^/?]+)\/(remove|restore)$/.exec(r.path.split("?")[0]!);
    if (sys) {
      const ws = await this.read("/api/workspace");
      const list = ((ws?.body as { services?: { id: string; name: string }[] } | undefined)
        ?.services ?? []) as { id: string; name: string }[];
      const name = list.find((x) => x.id === sys[1])?.name ?? sys[1]!;
      const removing = sys[2] === "remove";
      return {
        ...base,
        label: removing ? `Stop watching ${name} in Hearth` : `Watch ${name} in Hearth again`,
        policy: "approve-first",
        policyReason: "Ember changes Hearth itself only with your approval.",
        params: { ...(step.params ?? {}) },
        change: {
          summary: removing ? `Stop watching ${name}` : `Bring ${name} back`,
          settings: [
            {
              name,
              before: removing ? "watched by Hearth" : "removed from Hearth",
              after: removing
                ? "not watched (its history is kept; bring it back from Settings, Systems, Removed systems)"
                : "watched by Hearth again",
            },
            {
              name: "On the machine",
              before: "",
              after: "nothing changes: the app keeps running as it is",
            },
          ],
        },
      };
    }
    const settings: SettingChange[] = fields
      ? Object.entries(fields).map(([name, after]) => ({
          name,
          before: current ? show(current[name]) : "(could not be read first)",
          after: show(after),
        }))
      : [{ name: "request", before: "", after: `${r.method} ${r.path}` }];
    return {
      ...base,
      policy: "approve-first",
      policyReason: "Ember changes Hearth itself only with your approval.",
      params: { ...(step.params ?? {}) },
      change: { summary: `${r.method} ${r.path.split("?")[0]}`, settings },
    };
  }

  async run(step: StepRun): Promise<StepOutcome> {
    if (!this.call) return { ok: false, result: "Changing Hearth itself is not available here." };
    const r = this.request(step);
    const refused = planRefusal(r.method, r.path, r.body);
    if (refused) return { ok: false, result: refused, stale: true };
    const res = await this.call(EMBER_PLAN_SECRET, {
      method: r.method,
      path: r.path,
      ...(r.body ? { body: r.body } : {}),
    }).catch((e: unknown) => ({ status: 500, body: e instanceof Error ? e.message : String(e) }));
    if (res.status >= 400) {
      const why =
        res.body && typeof res.body === "object" && "error" in res.body
          ? String((res.body as { error: unknown }).error)
          : show(res.body);
      return { ok: false, result: `Hearth refused the change (${res.status}): ${why}` };
    }
    // Read the same place back and say what it shows now.
    if (r.method === "DELETE") return { ok: true, result: `Done: ${r.method} ${r.path}.` };
    const back = await this.read(r.path);
    let now = "";
    if (r.body && back && back.status < 400 && back.body && typeof back.body === "object") {
      try {
        const fields = JSON.parse(r.body) as Record<string, unknown>;
        now = Object.keys(fields)
          .map((k) => `${k} is now ${show((back.body as Record<string, unknown>)[k])}`)
          .join("; ");
      } catch {
        now = "";
      }
    }
    return {
      ok: true,
      result: now ? `Done and read back: ${now}.` : `Done: ${r.method} ${r.path}.`,
    };
  }
}
