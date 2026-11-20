import type { StepChange, StepParams } from "@dragon-control/core";
import type { StepRun } from "../jobs/operations";
import type { StepHost } from "./arr-sonarr-steps";

/**
 * The parts of the shared Servarr plan steps (arr-resource-operations.ts) that only Prowlarr has
 * (native panels Phase 3): its commands (push indexers to the apps, a backup, a scheduled task
 * now), adding an indexer from one of Prowlarr's definitions, and sending a search result to the
 * download client (a grab). Same contract as every step: the plan reads and states before and
 * after, the run reads again and stops if things changed, one call, read back, audit and journal.
 *
 * Secrets: a plan never carries a password, key or cookie. An indexer that needs one is refused
 * by Prowlarr's own save check, and the reason says to add it in Prowlarr for now.
 */

type Json = Record<string, unknown>;
type Service = { id: string; name: string; localUrl: string; hostId: string };

export class ProwlarrPlanError extends Error {}

const V1 = "/api/v1";
const COMMANDS: Record<string, string> = {
  ApplicationIndexerSync: "Push the indexers to the apps now",
  Backup: "Make a backup now",
  CheckHealth: "Check health now",
  IndexerDefinitionUpdate: "Update the indexer definitions now",
};
const NEVER = new Set(["ApplicationUpdate", "ApplicationUpdateCheck", "InstallUpdate"]);
const isSecret = (f: Json) =>
  (typeof f.privacy === "string" && f.privacy !== "normal") || f.type === "password";
const gb = (n: number) => `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;

export class ProwlarrSteps {
  constructor(private readonly h: StepHost) {}

  private async list(service: Service, path: string, what: string): Promise<Json[]> {
    const r = await this.h.lib.arr<Json[]>(service, "GET", path, what);
    if (!r.ok) throw new ProwlarrPlanError(`${service.name} did not give ${what} (${r.status}).`);
    return r.data ?? [];
  }

  async planCommand(
    service: Service,
    params: StepParams | undefined,
  ): Promise<[StepChange, StepParams]> {
    const name = typeof params?.command === "string" ? params.command : "";
    if (name === "GrabRelease") return this.planGrab(service, params);
    if (NEVER.has(name))
      throw new ProwlarrPlanError("Application updates stay in the app itself for now.");
    const tasks = await this.list(service, `${V1}/system/task`, "its scheduled tasks (plan)");
    const task = tasks.find((t) => t.taskName === name);
    if (!COMMANDS[name] && !task)
      throw new ProwlarrPlanError(
        `Say which command (params.command): ${[
          ...Object.keys(COMMANDS),
          "GrabRelease",
          ...tasks.map((t) => String(t.taskName)),
        ]
          .filter((n, i, a) => a.indexOf(n) === i && !NEVER.has(n))
          .join(", ")}.`,
      );
    const what = COMMANDS[name] ?? `Run "${String(task?.name ?? name)}" now`;
    return [
      {
        summary: `${what} in ${service.name}`,
        settings: [{ name: what, before: "Not running", after: "Runs once" }],
      },
      { command: name, what },
    ];
  }

  async runCommand(step: StepRun, service: Service, what: string, p: StepParams) {
    if (p.command === "GrabRelease") return this.runGrab(step, service, what, p);
    const sent = await this.h.lib.arr<Json>(
      service,
      "POST",
      `${V1}/command`,
      `${String(p.what)} (approved plan)`,
      { body: { name: p.command } },
    );
    if (!sent.ok)
      return { ok: false, result: `${service.name} refused the command (${sent.status}).` };
    let status = String(sent.data?.status ?? "queued");
    const id = sent.data?.id;
    for (let i = 0; i < 30 && !["completed", "failed"].includes(status) && id !== undefined; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const now = await this.h.lib.arr<Json>(
        service,
        "GET",
        `${V1}/command/${String(id)}`,
        "check the command",
      );
      status = String(now.data?.status ?? status);
    }
    const verified = status === "completed";
    const result = verified
      ? `${String(p.what)} finished in ${service.name} (it reported the command completed).`
      : status === "failed"
        ? `${service.name} ran ${String(p.what)}, but it failed. See its log in System.`
        : `${service.name} started ${String(p.what)}; it was still running after a minute (${status}).`;
    return this.h.finish(step, service, what, verified || status !== "failed", verified, result, {
      command: p.command,
      status,
    });
  }

  /**
   * A grab: Prowlarr sends a search result to its download client (or the indexer's own). The
   * result is named by its guid and indexer, never by its download link (which carries keys).
   */
  private async planGrab(
    service: Service,
    params: StepParams | undefined,
  ): Promise<[StepChange, StepParams]> {
    const guid = typeof params?.guid === "string" ? params.guid.trim() : "";
    const indexerId = Number(params?.indexerId);
    if (!guid || !Number.isInteger(indexerId) || indexerId <= 0)
      throw new ProwlarrPlanError("Say which result (params.guid and params.indexerId).");
    const indexer = await this.h.get(service, `${V1}/indexer/${indexerId}`, "the indexer");
    if (!indexer) throw new ProwlarrPlanError(`${service.name} has no indexer #${indexerId}.`);
    const clients = await this.list(service, `${V1}/downloadclient`, "its download clients");
    const own = Number(indexer.downloadClientId) || 0;
    const client =
      clients.find((c) => c.id === own) ??
      clients
        .filter((c) => c.enable !== false && c.protocol === indexer.protocol)
        .sort((a, b) => Number(a.priority ?? 1) - Number(b.priority ?? 1))[0];
    if (!client)
      throw new ProwlarrPlanError(
        `${service.name} has no ${String(indexer.protocol ?? "")} download client to send it to. Add one under Settings, Connections.`,
      );
    const named = params?.releaseTitle ?? params?.title;
    const title = typeof named === "string" && named ? named : guid;
    const size = Number(params?.size) || 0;
    return [
      {
        summary: `Send "${title}" from ${String(indexer.name)} to ${String(client.name)}`,
        settings: [
          {
            name: String(client.name),
            before: "Not sent",
            after: `Downloads "${title}"${size ? ` (${gb(size)})` : ""}`,
          },
        ],
      },
      {
        command: "GrabRelease",
        guid,
        indexerId,
        title,
        indexer: String(indexer.name),
        client: String(client.name),
        plannedAt: new Date().toISOString(),
      },
    ];
  }

  private async grabbed(service: Service, indexerId: number, title: string, since: string) {
    const r = await this.h.lib.arr<{ records?: Json[] }>(
      service,
      "GET",
      `${V1}/history?page=1&pageSize=50&sortKey=date&sortDirection=descending&indexerIds=${indexerId}&eventType=1`,
      "check the history",
    );
    return (r.data?.records ?? []).some((h) => {
      const d = (h.data as Json | undefined) ?? {};
      return (
        String(h.date ?? "") >= since.slice(0, 19) && String(d.grabTitle ?? d.title ?? "") === title
      );
    });
  }

  private async runGrab(step: StepRun, service: Service, what: string, p: StepParams) {
    const indexerId = Number(p.indexerId);
    const title = String(p.title);
    const since = String(p.plannedAt ?? new Date(0).toISOString());
    // A retried approval never sends it twice.
    if (await this.grabbed(service, indexerId, title, since))
      return {
        ok: false,
        stale: true,
        result: `"${title}" was already sent since this plan was made. Nothing was sent again.`,
      };
    const sent = await this.h.lib.arr<Json>(
      service,
      "POST",
      `${V1}/search`,
      `send "${title}" to the download client (approved plan)`,
      { body: { guid: p.guid, indexerId } },
    );
    if (!sent.ok) {
      const why = this.h.why(sent.data);
      const expired = /cache/i.test(why);
      return {
        ok: false,
        ...(expired ? { stale: true } : {}),
        result: expired
          ? `${service.name} no longer has that result (search results expire after a while). Search again and send it from the new results.`
          : `${service.name} could not send "${title}" (${sent.status}${why}).`,
      };
    }
    const verified = await this.grabbed(service, indexerId, title, since);
    const result = verified
      ? `${service.name} sent "${title}" to ${String(p.client)}, verified in its history.`
      : `${service.name} accepted "${title}", but its history does not show the grab yet.`;
    return this.h.finish(step, service, what, true, verified, result, {
      command: "GrabRelease",
      indexerId,
    });
  }

  /**
   * Adding an indexer from one of Prowlarr's definitions: the definition's own settings with the
   * owner's ordinary values, its sync profile, priority and tags. Secret settings are refused here.
   */
  async planIndexer(
    service: Service,
    params: StepParams | undefined,
  ): Promise<[StepChange, StepParams]> {
    let want: Json;
    try {
      want = JSON.parse(String(params?.body ?? "")) as Json;
    } catch {
      throw new ProwlarrPlanError("Say the indexer to add as JSON (params.body).");
    }
    const definition = String(want.definition ?? "");
    if (!definition) throw new ProwlarrPlanError("Say which definition (body.definition).");
    const schema = await this.list(service, `${V1}/indexer/schema`, "its indexer definitions");
    const base =
      schema.find((d) => d.name === definition) ??
      schema.find((d) => d.definitionName === definition);
    if (!base) throw new ProwlarrPlanError(`Prowlarr has no indexer definition "${definition}".`);
    const name = String(want.name ?? base.name ?? definition).trim();
    if (!name) throw new ProwlarrPlanError("Give the new indexer a name.");
    const have = await this.list(service, `${V1}/indexer`, "its indexers (plan)");
    if (have.some((i) => String(i.name).toLowerCase() === name.toLowerCase()))
      throw new ProwlarrPlanError(`${service.name} already has an indexer called "${name}".`);
    const values = (want.fields && typeof want.fields === "object" ? want.fields : {}) as Json;
    const fields = ((base.fields as Json[] | undefined) ?? []).map((f) => ({ ...f }));
    const changed: { name: string; before: string; after: string }[] = [];
    for (const [k, v] of Object.entries(values)) {
      const f = fields.find((x) => x.name === k);
      if (!f) throw new ProwlarrPlanError(`${definition} has no setting "${k}".`);
      if (isSecret(f))
        throw new ProwlarrPlanError(
          `"${String(f.label ?? k)}" is a secret. Hearth does not send secrets from a plan; add this indexer in ${service.name} itself for now.`,
        );
      f.value = v;
      changed.push({ name: String(f.label ?? k), before: "(new)", after: String(v) });
    }
    const profiles = await this.list(service, `${V1}/appprofile`, "its sync profiles");
    const profileId = Number(want.appProfileId ?? profiles[0]?.id);
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) throw new ProwlarrPlanError(`${service.name} has no sync profile #${profileId}.`);
    const priority = Math.min(50, Math.max(1, Number(want.priority ?? 25) || 25));
    const tags = Array.isArray(want.tags) ? want.tags.map(Number).filter(Number.isInteger) : [];
    const body: Json = {
      ...base,
      name,
      enable: want.enable !== false,
      appProfileId: profileId,
      priority,
      tags,
      fields,
    };
    delete body.id;
    delete body.presets;
    const secretsNeeded = fields.some(isSecret);
    return [
      {
        summary: `Add the indexer "${name}" (${String(base.name ?? definition)}) to ${service.name}`,
        settings: [
          { name: "Indexer", before: "(new)", after: `${name}, ${String(base.privacy ?? "")}` },
          { name: "Switched on", before: "(new)", after: body.enable ? "Yes" : "No" },
          { name: "Sync profile", before: "(new)", after: String(profile.name) },
          { name: "Priority", before: "(new)", after: String(priority) },
          ...changed,
          ...(secretsNeeded
            ? [
                {
                  name: "Logins and keys",
                  before: "(new)",
                  after: "Left empty. If the site needs one, Prowlarr refuses and you add it there",
                },
              ]
            : []),
        ],
      },
      { resource: "indexer", body: JSON.stringify(body), name },
    ];
  }
}
