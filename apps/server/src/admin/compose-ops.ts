import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ACTIONS,
  THIS_HOST,
  type ConfigEdit,
  type JobStepInput,
  type Requester,
  type StepChange,
} from "@dragon-control/core";
import type { ActionRunner } from "../actions/service";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import {
  composeJson,
  guardAll,
  newIssues,
  semanticDiff,
  servicesOf,
  type ComposeServiceSpec,
  type GuardPolicy,
} from "./compose";
import type { Elevation } from "./elevation";
import { applyEdits, maskSecrets, readTarget, sha256 } from "./files";
import type { Runner } from "./host";
import { applyCompose, composeFileOf } from "./protected";
import { backupKey, containerOf, GapError, isProtectedContainer, type HostScopes } from "./scope";

/**
 * Compose administration as plan steps: update a container's image, install a new app as its own
 * Compose project, and remove a project's containers. Each step is planned from what Compose and
 * Docker say now, judged by the mount guard, approved by the owner (protected ones with "it's
 * you"), then carried out and verified: containers running and not unhealthy, the image actually
 * changed, and Hearth's own check of the app passing. When verification fails, the file and the
 * previous image are put back and recreated. Restoring a Compose file never undoes what an app did
 * to its own data, and every plan says so.
 */

export class ComposePlanError extends Error {}

type Service = Awaited<ReturnType<HostScopes["service"]>>;
type Target = Awaited<ReturnType<typeof readTarget>>;

/** What ConfigOperations provides: writing files the same way every configuration step does. */
export interface ComposeWriter {
  route(file: string, isProtected: boolean): Promise<"direct" | "elevated">;
  put(
    step: StepRun,
    key: string,
    file: string,
    cur: Target,
    next: string,
    reason: string,
  ): Promise<
    { ok: true; backup: string; receipt?: string } | { ok: false; stale?: boolean; result: string }
  >;
  putBack(
    step: StepRun,
    w: { receipt?: string },
    file: string,
    cur: Target,
  ): Promise<{ ok: boolean; detail: string }>;
  viaRows(via: "direct" | "elevated"): StepChange["settings"];
  /** A backup of the file into the ledger (Hearth's own), returning where it went. */
  backupOnly(key: string, file: string, cur: Target): Promise<string>;
  record(
    step: StepRun,
    serviceName: string,
    serviceId: string,
    result: string,
    verified: boolean,
    detail: Record<string, unknown>,
  ): Promise<void>;
}

export interface ComposeOpsDeps {
  scopes: HostScopes;
  runner: ActionRunner;
  run: Runner;
  elevation?: Elevation;
  writer: ComposeWriter;
  guardPolicy(): GuardPolicy;
  /** For tests: how long to wait between container checks. */
  wait?: (ms: number) => Promise<void>;
}

const PROTECTED_REASON =
  "Changes a protected system or gives a container more reach: it waits for your approval, and approving asks you to confirm it's you.";
const CHANGE_REASON = "Changes how a container runs: it always waits for your approval.";
const DATA_NOTE =
  "Not covered by putting things back: if the new version changes the app's own data (for example upgrades its database), the old version may not read it. Back up the app's data first when that matters.";

const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const PROJECT = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const MAX_COMPOSE = 64 * 1024;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The exact edit that changes one service's image line, when the file says it plainly: the
 * service's own `image:` line with the current reference (not a variable). Otherwise a reason.
 */
export function imageEdit(
  content: string,
  service: string,
  current: string,
  next: string,
): ConfigEdit | string {
  // Spaces and tabs only: \s would reach across line ends.
  const line = new RegExp(
    `^([ \\t]*image:[ \\t]*["']?)${escape(current)}(["']?[ \\t]*(#.*)?)$`,
    "gm",
  );
  const all = [...content.matchAll(line)];
  if (!all.length)
    return `The file does not name ${current} directly (it may come from a variable); change it with a configuration edit instead.`;
  let m = all[0]!;
  if (all.length > 1) {
    // Several services use the same image: take the one under this service's own key.
    const key = new RegExp(`^([ \\t]*)${escape(service)}:[ \\t]*(#.*)?$`, "m").exec(content);
    if (!key) return `Several services use ${current} and ${service}'s own block was not found.`;
    const indent = key[1]!.length;
    const after = all.filter((x) => x.index! > key.index);
    const own = after.find((x) => {
      const between = content.slice(key.index + key[0].length, x.index);
      return !between
        .split("\n")
        .some(
          (l) =>
            l.trim() && !l.trimStart().startsWith("#") && l.length - l.trimStart().length <= indent,
        );
    });
    if (!own)
      return `${service}'s image line could not be told apart from the others using ${current}.`;
    m = own;
  }
  // The edit must be unambiguous in the whole file: take in the lines above it until it is.
  const end = m.index! + m[0].length;
  let from = m.index!;
  for (;;) {
    const find = content.slice(from, end);
    if (content.split(find).length === 2)
      return { find, replace: `${content.slice(from, m.index!)}${m[1]}${next}${m[2]}` };
    if (from === 0) return `${service}'s image line could not be pinned down exactly.`;
    from = content.lastIndexOf("\n", from - 2) + 1;
  }
}

/** Where Compose projects live on this machine: DC_COMPOSE_ROOT, or where most of them already are. */
export async function composeRoot(run: Runner, env = process.env): Promise<string | undefined> {
  if (env.DC_COMPOSE_ROOT) return path.posix.normalize(env.DC_COMPOSE_ROOT);
  const r = await run(
    "docker",
    ["ps", "-a", "--format", '{{.Label "com.docker.compose.project.config_files"}}'],
    20_000,
  ).catch(() => undefined);
  const counts = new Map<string, number>();
  for (const l of r?.out.split("\n") ?? []) {
    const f = l.split(",")[0]?.trim();
    if (!f || !f.startsWith("/")) continue;
    const root = path.posix.dirname(path.posix.dirname(f));
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export class ComposeOperations {
  constructor(private readonly d: ComposeOpsDeps) {}

  private wait(ms: number) {
    return this.d.wait ? this.d.wait(ms) : new Promise((r) => setTimeout(r, ms));
  }

  private async serviceOf(container: string): Promise<string | undefined> {
    const r = await this.d.run(
      "docker",
      ["inspect", "-f", '{{index .Config.Labels "com.docker.compose.service"}}', container],
      20_000,
    );
    const v = r.out.trim();
    return r.code === 0 && v && v !== "<no value>" ? v : undefined;
  }

  private async imageId(ref: string): Promise<string | undefined> {
    const r = await this.d.run("docker", ["image", "inspect", "-f", "{{.Id}}", ref], 20_000);
    return r.code === 0 ? r.out.trim() || undefined : undefined;
  }

  private async containerImage(container: string): Promise<string | undefined> {
    const r = await this.d.run("docker", ["inspect", "-f", "{{.Image}}", container], 20_000);
    return r.code === 0 ? r.out.trim() || undefined : undefined;
  }

  /** The guard on a change, as rows for the plan; refused things stop it. */
  private async judge(file: string, before: string | undefined, after: string) {
    const [b, a] = await Promise.all([
      before === undefined
        ? Promise.resolve({ config: undefined, error: undefined })
        : composeJson(this.d.run, file, before),
      composeJson(this.d.run, file, after),
    ]);
    if (a.error) throw new ComposePlanError(`Compose rejects it: ${a.error}`);
    const policy = this.d.guardPolicy();
    const sb: ComposeServiceSpec[] = b.config ? servicesOf(b.config) : [];
    const sa = servicesOf(a.config!);
    const added = newIssues(guardAll(sb, policy), guardAll(sa, policy));
    const refused = added.filter((i) => i.verdict === "refused");
    if (refused.length)
      throw new ComposePlanError(
        `Refused: ${refused.map((i) => `${i.service} would get ${i.what} (${i.why})`).join("; ")}. Hearth never gives a container that.`,
      );
    const rows: StepChange["settings"] = semanticDiff(sb, sa).map((x) => ({
      name: `${x.service} (as Compose reads it)`,
      before: before === undefined ? "Not there" : "As it is now",
      after: x.change,
    }));
    for (const i of added.filter((x) => x.verdict === "protected"))
      rows.push({
        name: `${i.service}: needs your confirmation`,
        before: "Not allowed now",
        after: `${i.what}: ${i.why}`,
      });
    return { rows, protected: added.some((i) => i.verdict === "protected"), services: sa };
  }

  private async policy(
    kind: JobStepInput["kind"],
    serviceId: string,
    requestedBy: Requester,
    isProtected: boolean,
  ): Promise<Pick<PlannedStep, "policy" | "policyReason">> {
    if (serviceId === THIS_HOST)
      return {
        policy: "approve-first",
        policyReason: isProtected ? PROTECTED_REASON : CHANGE_REASON,
      };
    const { decision } = await this.d.runner.policyFor(kind, serviceId, requestedBy);
    if (decision.outcome === "refuse") return { policy: "refuse", policyReason: decision.reason };
    return {
      policy: "approve-first",
      policyReason: isProtected ? PROTECTED_REASON : CHANGE_REASON,
    };
  }

  async plan(step: JobStepInput, requestedBy: Requester): Promise<PlannedStep> {
    const s =
      step.serviceId === THIS_HOST
        ? undefined
        : await this.d.scopes.service(step.serviceId).catch(() => undefined);
    const base: PlannedStep = {
      label: ACTIONS[step.kind].describe(s?.name ?? step.serviceId),
      serviceName: s?.name ?? (step.serviceId === THIS_HOST ? "This machine" : step.serviceId),
      changes: true,
      policy: "refuse",
      policyReason: "",
    };
    try {
      await this.d.scopes.require("propose");
      const p = step.params ?? {};
      let planned: Omit<PlannedStep, "policy" | "policyReason" | "serviceName" | "changes">;
      let isProtected: boolean;
      if (step.kind === "compose-install") {
        if (step.serviceId !== THIS_HOST)
          throw new ComposePlanError(
            `A new app is installed on the machine: use serviceId "${THIS_HOST}".`,
          );
        ({ planned, isProtected } = await this.planInstall(p));
      } else {
        if (step.serviceId === THIS_HOST)
          ({ planned, isProtected } =
            step.kind === "compose-update-image"
              ? await this.planImage(undefined, p)
              : await this.planRemove(undefined, p));
        else {
          if (!s) throw new ComposePlanError(`No service "${step.serviceId}".`);
          ({ planned, isProtected } =
            step.kind === "compose-update-image"
              ? await this.planImage(s, p)
              : await this.planRemove(s, p));
        }
      }
      return {
        ...base,
        ...planned,
        ...(await this.policy(step.kind, step.serviceId, requestedBy, isProtected)),
      };
    } catch (error) {
      return { ...base, policyReason: error instanceof Error ? error.message : String(error) };
    }
  }

  /* ---------- update an image ---------- */

  /**
   * What an image update acts on: a service Hearth watches, or (serviceId this-host) a Compose
   * project and service by name, so projects Hearth has not adopted can be administered too.
   */
  private async imageTarget(s: Service | undefined, p: Record<string, unknown>) {
    if (s) {
      const container = containerOf(s);
      if (!container) throw new ComposePlanError(`${s.name} has no container Hearth knows.`);
      const file = await composeFileOf(this.d.run, container);
      if (!file)
        throw new ComposePlanError(`Docker does not say which Compose file made ${container}.`);
      const service = await this.serviceOf(container);
      if (!service) throw new ComposePlanError(`${container} has no Compose service name.`);
      return { name: s.name, watched: true, key: backupKey(s), container, file, service };
    }
    const project = String(p.project ?? "");
    if (!PROJECT.test(project))
      throw new ComposePlanError(
        "Say which project (params.project) and, when it has several, which service (params.service).",
      );
    const file = await this.projectFile(project);
    if (!file) throw new ComposePlanError(`No Compose project named ${project}.`);
    const conf = await composeJson(this.d.run, file);
    const names = conf.config ? servicesOf(conf.config).map((x) => x.name) : [];
    const service = typeof p.service === "string" && p.service ? p.service : names[0];
    if (!service || !names.includes(service) || (!p.service && names.length > 1))
      throw new ComposePlanError(
        `Say which of ${project}'s services to update (params.service): ${names.join(", ")}.`,
      );
    const ps = await this.d.run(
      "docker",
      ["compose", "-f", file, "ps", "-a", "--format", "json"],
      30_000,
    );
    const container = ps.out
      .split("\n")
      .filter((l) => l.trim().startsWith("{"))
      .map((l) => JSON.parse(l) as { Service?: string; Name?: string })
      .find((r) => r.Service === service)?.Name;
    if (!container)
      throw new ComposePlanError(`${project}'s ${service} has no container yet; start it first.`);
    return {
      name: `${project} (${service})`,
      watched: false,
      key: project,
      container,
      file,
      service,
    };
  }

  private async planImage(s: Service | undefined, p: Record<string, unknown>) {
    const { name, watched, key, container, file, service } = await this.imageTarget(s, p);
    const gate = await this.d.scopes.requireChangeable(file, { allowProtected: true });
    const cur = await readTarget(file);
    const conf = await composeJson(this.d.run, file);
    if (conf.error) throw new ComposePlanError(`Compose cannot read ${file}: ${conf.error}`);
    const spec = servicesOf(conf.config!).find((x) => x.name === service);
    const current = spec?.image;
    if (!current)
      throw new ComposePlanError(`${service} has no image in ${file} (it may be built locally).`);
    const want = typeof p.image === "string" && p.image.trim() ? p.image.trim() : current;
    if (!IMAGE_REF.test(want)) throw new ComposePlanError(`"${want}" is not an image reference.`);
    const protectedSystem = Boolean(gate.protected) || isProtectedContainer(container, current);
    const then = `Download it, recreate the project's containers (each drops for about a minute), then check they run${watched ? ` and that ${name} answers Hearth's check` : " (Hearth does not watch this app yet, so its containers are what is checked)"}`;
    if (want === current) {
      const change: StepChange = {
        summary: `Update ${name} to the newest build of ${current}`,
        settings: [
          {
            name: "Image",
            before: `${current} (the build on this machine)`,
            after: `${current} (the newest build, if there is one)`,
          },
          {
            name: "Then",
            before: "Running",
            after: `${then}. If the download is the same build, nothing is recreated.`,
          },
          {
            name: "If it does not come back working",
            before: "",
            after: "The previous build is put back and recreated.",
          },
          { name: "The app's data", before: "", after: DATA_NOTE },
        ],
      };
      return {
        isProtected: protectedSystem,
        planned: {
          label: change.summary,
          change,
          params: {
            mode: "refresh",
            path: file,
            service,
            container,
            key,
            image: current,
            ...(protectedSystem ? { protected: "yes" } : {}),
          },
        },
      };
    }
    const edit = imageEdit(cur.content, service, current, want);
    if (typeof edit === "string") throw new ComposePlanError(edit);
    const after = applyEdits(cur.content, [edit]).after;
    const judged = await this.judge(file, cur.content, after);
    const isProtected = protectedSystem || judged.protected;
    const via = await this.d.writer.route(file, isProtected);
    const change: StepChange = {
      summary: `Update ${name} from ${current} to ${want}`,
      settings: [
        { name: `${path.basename(file)}, ${service}'s image`, before: current, after: want },
        ...judged.rows.filter((r) => !r.after.startsWith("Image:")),
        { name: "Then", before: "Running", after: then },
        {
          name: "If it does not come back working",
          before: "",
          after: `The file goes back to ${current} and that image (still on this machine) is recreated.`,
        },
        { name: "The app's data", before: "", after: DATA_NOTE },
        ...this.d.writer.viaRows(via),
      ],
    };
    return {
      isProtected,
      planned: {
        label: change.summary,
        change,
        params: {
          mode: "change",
          path: file,
          service,
          container,
          key,
          image: want,
          previous: current,
          edits: JSON.stringify([edit]),
          beforeHash: cur.hash,
          afterHash: sha256(after),
          apply: "compose",
          ...(isProtected ? { protected: "yes" } : {}),
          ...(via === "elevated" ? { via } : {}),
        },
      },
    };
  }

  /** Hearth's own check of the app after a recreate, when it watches it. */
  private async appCheck(serviceId: string): Promise<string | undefined> {
    const r = await this.d.runner.checkService(serviceId).catch(() => undefined);
    if (!r) return undefined;
    return r.status === "failing" ? `Hearth's check of the app fails: ${r.detail}` : undefined;
  }

  private async runImage(
    step: StepRun,
    s: Service | undefined,
    undo: boolean,
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    // A service Hearth watches, or a project by name (serviceId this-host).
    const name = s?.name ?? `${String(p.key)} (${String(p.service)})`;
    const sid = s?.id ?? THIS_HOST;
    const file = String(p.path);
    const container = String(p.container);
    const ref = String(p.image);
    await this.d.scopes.requireChangeable(file, { allowProtected: p.protected === "yes" });
    if (p.mode === "refresh") {
      if (undo) return { ok: true, result: "Nothing to put back here: a later check decides." };
      const oldId = await this.containerImage(container);
      if (!oldId)
        return {
          ok: false,
          result: `${container} is not there any more. Nothing was changed.`,
          stale: true,
        };
      const pull = await this.d.run("docker", ["pull", ref], 600_000);
      if (pull.code !== 0)
        return {
          ok: false,
          result: `Could not download ${ref}: ${pull.out.trim().slice(-300)}. Nothing was changed.`,
        };
      const newId = await this.imageId(ref);
      if (!newId || newId === oldId) {
        const result = `${name} already runs the newest build of ${ref}; nothing was recreated.`;
        await this.d.writer.record(step, name, sid, result, true, { image: ref });
        return { ok: true, result };
      }
      const problem = await this.applyAndCheck(file, sid, container, newId);
      if (!problem) {
        const result = `${name} now runs the newest build of ${ref} (${newId.slice(7, 19)}, was ${oldId.slice(7, 19)}): containers running and Hearth's check passes.`;
        await this.d.writer.record(step, name, sid, result, true, {
          image: ref,
          from: oldId,
          to: newId,
        });
        return { ok: true, result };
      }
      // Point the tag back at the build that worked, and recreate from it.
      await this.d.run("docker", ["tag", oldId, ref], 30_000);
      const back = await this.applyAndCheck(file, sid, container, oldId);
      const result = `${problem} So the previous build was put back${back ? `, but it did not come back cleanly either: ${back}` : " and is running again"}. The app's own data is not rolled back by this.`;
      await this.d.writer.record(step, name, sid, result, false, {
        image: ref,
        from: oldId,
        to: newId,
        rolledBack: true,
      });
      return { ok: false, result };
    }
    // A changed image reference: the Compose file is edited.
    const cur = await readTarget(file);
    const key = typeof p.key === "string" ? p.key : backupKey(s!);
    if (undo) {
      if (cur.hash !== p.afterHash)
        return {
          ok: false,
          result: `${path.basename(file)} changed since this step; it was not put back.`,
        };
      const prev = applyEdits(cur.content, [
        {
          find: (JSON.parse(String(p.edits)) as ConfigEdit[])[0]!.replace,
          replace: (JSON.parse(String(p.edits)) as ConfigEdit[])[0]!.find,
        },
      ]).after;
      const w = await this.d.writer.put(step, key, file, cur, prev, "undo");
      if (!w.ok) return { ok: false, result: w.result };
      const problem = await this.applyAndCheck(file, sid, container);
      return problem
        ? { ok: false, result: `Put the image back to ${String(p.previous)}, but: ${problem}` }
        : { ok: true, result: `Put ${name} back on ${String(p.previous)} and it is running.` };
    }
    if (cur.hash !== p.beforeHash)
      return {
        ok: false,
        stale: true,
        result: `${path.basename(file)} changed since this plan was approved. Nothing was changed; plan it again.`,
      };
    const next = applyEdits(cur.content, JSON.parse(String(p.edits)) as ConfigEdit[]).after;
    if (sha256(next) !== p.afterHash)
      return {
        ok: false,
        stale: true,
        result: "The edit no longer gives the approved file. Nothing was changed.",
      };
    const pull = await this.d.run("docker", ["pull", ref], 600_000);
    if (pull.code !== 0)
      return {
        ok: false,
        result: `Could not download ${ref}: ${pull.out.trim().slice(-300)}. Nothing was changed.`,
      };
    const newId = await this.imageId(ref);
    const w = await this.d.writer.put(step, key, file, cur, next, "image");
    if (!w.ok) return { ok: false, ...(w.stale ? { stale: true } : {}), result: w.result };
    if ((await readTarget(file)).hash !== p.afterHash) {
      await this.d.writer.putBack(step, w, file, cur);
      return {
        ok: false,
        result: `${path.basename(file)} did not read back as approved; it was put back.`,
      };
    }
    const problem = await this.applyAndCheck(file, sid, container, newId);
    if (!problem) {
      const result = `${name} now runs ${ref} (was ${String(p.previous)}): containers running and Hearth's check passes. Backup of the file: ${w.backup}.`;
      await this.d.writer.record(step, name, sid, result, true, {
        file,
        backup: w.backup,
        image: ref,
      });
      return { ok: true, result };
    }
    const undone = await this.d.writer.putBack(step, w, file, cur);
    const back = undone.ok ? await this.applyAndCheck(file, sid, container) : undone.detail;
    const result = `${problem} So ${path.basename(file)} went back to ${String(p.previous)}${back ? `, but bringing it back had trouble: ${back}` : " and it is running again"}. The app's own data is not rolled back by this. Backup: ${w.backup}.`;
    await this.d.writer.record(step, name, sid, result, false, {
      file,
      backup: w.backup,
      rolledBack: true,
    });
    return { ok: false, result };
  }

  /**
   * Recreates the project and verifies: every container running and not unhealthy, the service's
   * container on the expected image, and Hearth's check of the app. The problem, or undefined.
   */
  private async applyAndCheck(
    file: string,
    serviceId: string,
    container: string,
    imageId?: string,
  ): Promise<string | undefined> {
    const a = await applyCompose(this.d.run, file, (ms) => this.wait(ms));
    if (!a.ok) return a.detail;
    if (imageId) {
      const now = await this.containerImage(container);
      if (now !== imageId)
        return `${container} is not on the new image after recreating (it runs ${now?.slice(7, 19) ?? "nothing"}).`;
    }
    return this.appCheck(serviceId);
  }

  /* ---------- install a new app ---------- */

  private async planInstall(p: Record<string, unknown>) {
    const project = String(p.project ?? "").trim();
    if (!PROJECT.test(project))
      throw new ComposePlanError(
        "Give the project a short name: lowercase letters, digits, - or _ (params.project).",
      );
    const content = typeof p.compose === "string" ? p.compose : "";
    if (!content.trim())
      throw new ComposePlanError("Give the Compose file's content (params.compose).");
    if (Buffer.byteLength(content) > MAX_COMPOSE)
      throw new ComposePlanError("The Compose file is larger than 64 KB.");
    if (content.includes("<masked>"))
      throw new ComposePlanError("The Compose file contains a masked value.");
    const root = await composeRoot(this.d.run);
    if (!root)
      throw new GapError(
        "Hearth does not know where Compose projects live on this machine. The owner can set DC_COMPOSE_ROOT for Hearth's service.",
        "missing-permission",
      );
    const dir = path.posix.join(root, project);
    const file = path.posix.join(dir, "compose.yml");
    const gate = await this.d.scopes.requireChangeable(file, { allowProtected: true });
    if (
      await fs.stat(dir).then(
        () => true,
        () => false,
      )
    )
      throw new ComposePlanError(
        `${dir} already exists; choose another name or change that project instead.`,
      );
    const ls = await this.d.run("docker", ["compose", "ls", "-a", "--format", "json"], 20_000);
    if (
      ls.code === 0 &&
      (JSON.parse(ls.out || "[]") as { Name?: string }[]).some((x) => x.Name === project)
    )
      throw new ComposePlanError(`A Compose project named ${project} already exists.`);
    const judged = await this.judge(file, undefined, content);
    if (!judged.services.length) throw new ComposePlanError("The Compose file has no services.");
    const isProtected = Boolean(gate.protected) || judged.protected;
    const via = await this.createRoute(root, isProtected);
    const binds = judged.services.flatMap((x) =>
      x.volumes.filter((v) => v.type === "bind" && v.source).map((v) => v.source!),
    );
    const change: StepChange = {
      summary: `Install ${project} as a new Compose project (${judged.services.map((x) => x.name).join(", ")})`,
      settings: [
        { name: "New folder", before: "Not there", after: dir },
        { name: "compose.yml", before: "Not there", after: maskSecrets(content, "yaml") },
        ...judged.rows,
        ...(binds.length
          ? [
              {
                name: "Folders it uses",
                before: "",
                after: `${[...new Set(binds)].join(", ")} (Docker creates missing ones; they stay if it is removed)`,
              },
            ]
          : []),
        {
          name: "Then",
          before: "Not running",
          after: "Start it, then check every container runs and none is unhealthy",
        },
        {
          name: "If it does not start cleanly",
          before: "",
          after:
            "Its containers are removed and the new file and folder are taken away. Folders and volumes its containers created stay and are listed.",
        },
        ...this.d.writer.viaRows(via),
      ],
    };
    return {
      isProtected,
      planned: {
        label: change.summary,
        change,
        params: {
          project,
          path: file,
          compose: content,
          afterHash: sha256(content),
          ...(isProtected ? { protected: "yes" } : {}),
          ...(via === "elevated" ? { via } : {}),
        },
      },
    };
  }

  /** New projects: the executor when it covers the folder (it gives them the folder's owner), else Hearth. */
  private async createRoute(root: string, isProtected: boolean): Promise<"direct" | "elevated"> {
    const probe = path.posix.join(root, "new-project");
    const [dir, file] = this.d.elevation
      ? await Promise.all([
          this.d.elevation.covers("dir.create", probe),
          this.d.elevation.covers("file.write", path.posix.join(probe, "compose.yml")),
        ])
      : [undefined, undefined];
    // Protected or not, the executor is preferred when it covers the folder: it gives the new
    // project the folder's owner, so the owner can edit it as before.
    if (dir?.ok && file?.ok) return "elevated";
    void isProtected;
    const writable = await fs.access(root, fsConstants.W_OK).then(
      () => true,
      () => false,
    );
    if (writable) return "direct";
    const why =
      dir && !dir.ok
        ? dir.why
        : file && !file.ok
          ? file.why
          : "The elevated executor is not set up on this machine.";
    throw new GapError(
      `Hearth's own account cannot create folders in ${root}. ${why} Once that is done, Ember can install it with your approval.`,
      dir && !dir.ok && dir.scope ? "out-of-scope" : "missing-permission",
    );
  }

  private async runInstall(step: StepRun, undo: boolean): Promise<StepOutcome> {
    const p = step.params ?? {};
    const file = String(p.path);
    const dir = path.posix.dirname(file);
    const content = String(p.compose ?? "");
    const project = String(p.project);
    if (sha256(content) !== p.afterHash)
      return { ok: false, result: "The Compose file is not the one approved." };
    await this.d.scopes.requireChangeable(file, { allowProtected: p.protected === "yes" });
    if (undo) return this.uninstall(step, file, dir, content);
    if (
      await fs.stat(dir).then(
        () => true,
        () => false,
      )
    )
      return { ok: false, stale: true, result: `${dir} exists now; nothing was installed.` };
    const made = await this.create(step, dir, file, content);
    if (!made.ok) return { ok: false, result: made.result };
    const before = await this.existing(content, file);
    const a = await applyCompose(this.d.run, file, (ms) => this.wait(ms));
    if (a.ok) {
      const result = `Installed ${project} in ${dir}: ${a.detail} To have Hearth watch it, add it with a discovery scan (Settings, Discover); until then it can be administered by its project name.`;
      await this.d.writer.record(step, project, THIS_HOST, result, true, { file });
      return { ok: true, result };
    }
    const removed = await this.uninstall(step, file, dir, content, before);
    const result = `${project} did not start cleanly (${a.detail}). ${removed.result}`;
    await this.d.writer.record(step, project, THIS_HOST, result, false, { file, rolledBack: true });
    return { ok: false, result };
  }

  /** Bind-mount folders the project uses that exist now (so a rollback can say which it made). */
  private async existing(content: string, file: string): Promise<Set<string>> {
    const c = await composeJson(this.d.run, file, content);
    const out = new Set<string>();
    for (const x of c.config ? servicesOf(c.config) : [])
      for (const v of x.volumes)
        if (
          v.type === "bind" &&
          v.source &&
          (await fs.stat(v.source).then(
            () => true,
            () => false,
          ))
        )
          out.add(v.source);
    return out;
  }

  private async create(step: StepRun, dir: string, file: string, content: string) {
    if (step.params?.via === "elevated" && this.d.elevation) {
      const root = await fs.stat(path.posix.dirname(dir));
      const d = await this.d.elevation.perform(
        "dir.create",
        { path: dir, mode: 0o775, uid: root.uid, gid: root.gid },
        step,
      );
      if (!d.ok)
        return { ok: false, result: `The elevated executor did not create ${dir}: ${d.result}` };
      const f = await this.d.elevation.perform(
        "file.write",
        {
          path: file,
          key: path.posix.basename(dir),
          beforeHash: null,
          afterHash: sha256(content),
          content: Buffer.from(content, "utf8").toString("base64"),
          create: { mode: 0o664, uid: root.uid, gid: root.gid },
        },
        step,
      );
      if (!f.ok) {
        await this.d.elevation.perform("dir.remove", { path: dir }, step);
        return { ok: false, result: `The elevated executor did not write ${file}: ${f.result}` };
      }
      return { ok: true, result: "" };
    }
    await fs.mkdir(dir, { mode: 0o775 });
    await fs.writeFile(file, content, { flag: "wx", mode: 0o664 });
    if ((await readTarget(file)).hash !== sha256(content))
      return { ok: false, result: `${file} did not read back as approved.` };
    return { ok: true, result: "" };
  }

  /** Stops and removes the project's containers, then its file and folder (only if nothing else is in it). */
  private async uninstall(
    step: StepRun,
    file: string,
    dir: string,
    content: string,
    before?: Set<string>,
  ): Promise<StepOutcome> {
    const down = await this.d.run("docker", ["compose", "-f", file, "down"], 300_000);
    if (down.code !== 0)
      return {
        ok: false,
        result: `Its containers could not be removed: ${down.out.trim().slice(-300)}`,
      };
    const made = before
      ? [...(await this.existing(content, file).catch(() => new Set<string>()))].filter(
          (x) => !before.has(x),
        )
      : [];
    const cur = await readTarget(file).catch(() => undefined);
    if (cur && cur.hash !== sha256(content))
      return {
        ok: false,
        result: `Its containers are removed; ${file} changed since, so it was left in place.`,
      };
    const elevated = step.params?.via === "elevated" && this.d.elevation;
    let problem = "";
    if (cur && elevated) {
      const r = await this.d.elevation!.perform(
        "file.remove",
        { path: file, key: path.posix.basename(dir), beforeHash: cur.hash },
        step,
      );
      if (!r.ok) problem = r.result;
    } else if (cur) await fs.rm(file).catch((e: Error) => (problem = e.message));
    const left = await fs.readdir(dir).catch(() => [] as string[]);
    if (!problem && !left.length) {
      if (elevated) {
        const r = await this.d.elevation!.perform("dir.remove", { path: dir }, step);
        if (!r.ok) problem = r.result;
      } else await fs.rmdir(dir).catch((e: Error) => (problem = e.message));
    }
    const leftover = made.length
      ? ` Folders its containers created are left: ${made.join(", ")}.`
      : "";
    if (problem)
      return {
        ok: false,
        result: `Its containers are removed, but its file or folder could not be: ${problem}.${leftover}`,
      };
    return {
      ok: true,
      result: `Its containers and ${path.posix.basename(file)} were removed${left.length ? `; ${dir} still holds other files, so it stays` : `, and the empty folder ${dir} too`}.${leftover}`,
    };
  }

  /* ---------- remove a project's containers ---------- */

  /** A project's Compose file, by its name (`docker compose ls`), for projects Hearth does not list. */
  private async projectFile(project: string): Promise<string | undefined> {
    const ls = await this.d.run("docker", ["compose", "ls", "-a", "--format", "json"], 20_000);
    if (ls.code !== 0) return undefined;
    const rows = JSON.parse(ls.out || "[]") as { Name?: string; ConfigFiles?: string }[];
    return (
      rows
        .find((r) => r.Name === project)
        ?.ConfigFiles?.split(",")[0]
        ?.trim() || undefined
    );
  }

  private async planRemove(s: Service | undefined, p: Record<string, unknown>) {
    let container = s ? containerOf(s) : undefined;
    let file: string | undefined;
    if (s) {
      if (!container) throw new ComposePlanError(`${s.name} has no container Hearth knows.`);
      file = await composeFileOf(this.d.run, container);
    } else {
      const project = String(p.project ?? "");
      if (!PROJECT.test(project))
        throw new ComposePlanError(
          "Say which project (params.project), as compose_projects lists it.",
        );
      file = await this.projectFile(project);
      if (!file) throw new ComposePlanError(`No Compose project named ${project}.`);
      container = project;
    }
    const name = s?.name ?? container!;
    const isProtected =
      isProtectedContainer(container!, s?.image ?? "") ||
      (file ? this.d.scopes.classify(file).class === "protected" : false);
    const removeFiles = p.removeFiles === true;
    if (
      file &&
      (await fs.stat(file).then(
        () => true,
        () => false,
      ))
    ) {
      await this.d.scopes.requireChangeable(file, { allowProtected: true });
      const ps = await this.d.run(
        "docker",
        ["compose", "-f", file, "ps", "-a", "--format", "json"],
        30_000,
      );
      const rows = ps.out
        .split("\n")
        .filter((l) => l.trim().startsWith("{"))
        .map((l) => JSON.parse(l) as { Name?: string; State?: string });
      const cur = removeFiles ? await readTarget(file) : undefined;
      const via = removeFiles ? await this.d.writer.route(file, isProtected) : undefined;
      const change: StepChange = {
        summary: removeFiles
          ? `Remove ${name}'s Compose project: its containers and its Compose file`
          : `Remove the containers of ${name}'s Compose project`,
        settings: [
          {
            name: "Containers removed",
            before: rows.map((r) => `${r.Name} (${r.State})`).join(", ") || "None running",
            after: "Gone",
          },
          ...(removeFiles
            ? [
                {
                  name: "Compose file removed",
                  before: file,
                  after: `Gone, with a backup first; its folder too if nothing else is in it`,
                },
                {
                  name: "Kept",
                  before: "",
                  after:
                    "Its volumes, images, and every folder its containers use: no data is deleted",
                },
                {
                  name: "Bringing it back",
                  before: "",
                  after: "From the backup of its Compose file, as a new install",
                },
              ]
            : [
                {
                  name: "Kept",
                  before: "",
                  after: `${file}, its volumes, and every folder it uses: nothing is deleted from disk`,
                },
                {
                  name: "Bringing it back",
                  before: "",
                  after: "Start it again from the same Compose file at any time",
                },
              ]),
          ...(via ? this.d.writer.viaRows(via) : []),
        ],
      };
      return {
        isProtected,
        planned: {
          label: change.summary,
          change,
          params: {
            mode: "compose",
            path: file,
            container: container!,
            ...(cur ? { removeFiles: true, fileHash: cur.hash } : {}),
            ...(isProtected ? { protected: "yes" } : {}),
            ...(via === "elevated" ? { via } : {}),
          },
        },
      };
    }
    if (!s) throw new ComposePlanError(`${file} is not there.`);
    // A leftover whose Compose file is gone: remove only that stopped container.
    const st = await this.d.run(
      "docker",
      ["inspect", "-f", "{{.State.Status}}", container!],
      20_000,
    );
    const state = st.out.trim();
    if (st.code !== 0) throw new ComposePlanError(`${container} is not there.`);
    if (state === "running" || state === "restarting")
      throw new ComposePlanError(
        `${container} is ${state} and its Compose file is gone; stop it first (stop-container).`,
      );
    const change: StepChange = {
      summary: `Remove the leftover container ${container}`,
      settings: [
        { name: "Container removed", before: `${container} (${state})`, after: "Gone" },
        { name: "Kept", before: "", after: "Its image, volumes, and folders" },
        { name: "Bringing it back", before: "", after: "Not by Hearth: its Compose file is gone" },
      ],
    };
    return {
      isProtected,
      planned: {
        label: change.summary,
        change,
        params: {
          mode: "container",
          container: container!,
          ...(isProtected ? { protected: "yes" } : {}),
        },
      },
    };
  }

  private async runRemove(
    step: StepRun,
    s: Service | undefined,
    undo: boolean,
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const container = String(p.container);
    const name = s?.name ?? container;
    const serviceId = s?.id ?? THIS_HOST;
    if (p.mode === "container") {
      if (undo)
        return {
          ok: false,
          result: "A leftover container without a Compose file cannot be brought back by Hearth.",
        };
      const st = await this.d.run(
        "docker",
        ["inspect", "-f", "{{.State.Status}}", container],
        20_000,
      );
      if (st.code !== 0) return { ok: true, result: `${container} was already gone.` };
      if (["running", "restarting"].includes(st.out.trim()))
        return {
          ok: false,
          stale: true,
          result: `${container} is ${st.out.trim()} now; it was not removed.`,
        };
      const r = await this.d.run("docker", ["rm", container], 60_000);
      const gone = (await this.d.run("docker", ["inspect", container], 20_000)).code !== 0;
      const result = gone
        ? `Removed the leftover container ${container}; its image, volumes, and folders are kept.`
        : `${container} is still there: ${r.out.trim().slice(-200)}`;
      await this.d.writer.record(step, name, serviceId, result, gone, { container });
      return { ok: gone, result };
    }
    const file = String(p.path);
    await this.d.scopes.requireChangeable(file, { allowProtected: p.protected === "yes" });
    if (undo) {
      if (p.removeFiles === true)
        return {
          ok: false,
          result: `Not started again automatically: its Compose file was removed (a backup is in the ledger).`,
        };
      const a = await applyCompose(this.d.run, file, (ms) => this.wait(ms));
      return {
        ok: a.ok,
        result: a.ok ? `Started ${name}'s project again: ${a.detail}` : a.detail,
      };
    }
    if (p.removeFiles === true) {
      const cur = await readTarget(file).catch(() => undefined);
      if (!cur || cur.hash !== p.fileHash)
        return {
          ok: false,
          stale: true,
          result: `${file} changed since this plan was approved. Nothing was removed.`,
        };
    }
    const r = await this.d.run("docker", ["compose", "-f", file, "down"], 300_000);
    const left = await this.d.run("docker", ["compose", "-f", file, "ps", "-a", "-q"], 30_000);
    let ok = r.code === 0 && !left.out.trim();
    let result = ok
      ? `Removed the containers of ${name}'s project. ${file}, its volumes, and its folders are untouched.`
      : `Not all of its containers were removed: ${(r.out || left.out).trim().slice(-300)}`;
    if (ok && p.removeFiles === true) {
      const gone = await this.removeProjectFile(step, file);
      ok = gone.ok;
      result = gone.ok
        ? `Removed ${name}'s project: its containers and ${gone.detail} Its volumes and data folders are kept.`
        : `Its containers are removed, but its Compose file could not be: ${gone.detail}`;
    }
    await this.d.writer.record(step, name, serviceId, result, ok, { file });
    return { ok, result };
  }

  /** Removes a project's Compose file (backed up first) and its folder when nothing else is in it. */
  private async removeProjectFile(
    step: StepRun,
    file: string,
  ): Promise<{ ok: boolean; detail: string }> {
    const dir = path.posix.dirname(file.replaceAll("\\", "/"));
    const key = path.posix.basename(dir);
    const cur = await readTarget(file);
    // Exactly the file that was approved for removal, not whatever is there now.
    const approved = String(step.params?.fileHash ?? "");
    if (cur.hash !== approved)
      return { ok: false, detail: `${file} changed since this plan was approved; it was kept` };
    let backup: string;
    if (step.params?.via === "elevated" && this.d.elevation) {
      const r = await this.d.elevation.perform(
        "file.remove",
        { path: file, key, beforeHash: approved },
        step,
      );
      if (!r.ok) return { ok: false, detail: r.result };
      backup = r.backup ?? "";
    } else {
      // Hearth's own backup first, in the ledger convention, then the file goes.
      backup = await this.d.writer.backupOnly(key, file, cur);
      await fs.rm(file);
    }
    const left = await fs.readdir(dir).catch(() => [] as string[]);
    if (!left.length) {
      if (step.params?.via === "elevated" && this.d.elevation) {
        const r = await this.d.elevation.perform("dir.remove", { path: dir }, step);
        if (!r.ok)
          return {
            ok: true,
            detail: `its Compose file (backup: ${backup}); ${dir} stays: ${r.result}.`,
          };
      } else await fs.rmdir(dir).catch(() => undefined);
    }
    return {
      ok: true,
      detail: `its Compose file (backup: ${backup})${left.length ? `; ${dir} keeps its other files` : `, and the empty folder ${dir}`}.`,
    };
  }

  async run(step: StepRun, opts: { undo?: boolean } = {}): Promise<StepOutcome> {
    try {
      if (step.kind === "compose-install") return await this.runInstall(step, Boolean(opts.undo));
      if (step.kind === "compose-remove" && step.serviceId === THIS_HOST)
        return await this.runRemove(step, undefined, Boolean(opts.undo));
      if (step.kind === "compose-update-image" && step.serviceId === THIS_HOST)
        return await this.runImage(step, undefined, Boolean(opts.undo));
      const s = await this.d.scopes.service(step.serviceId);
      if (step.kind === "compose-update-image")
        return await this.runImage(step, s, Boolean(opts.undo));
      return await this.runRemove(step, s, Boolean(opts.undo));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, result: error instanceof GapError ? `${msg} Nothing was changed.` : msg };
    }
  }
}
