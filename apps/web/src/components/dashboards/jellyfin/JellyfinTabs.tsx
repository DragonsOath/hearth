import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, Smartphone, UserRound } from "lucide-react";
import { api } from "../../../data/api";
import { ago } from "../../../lib/format";
import type { AppViewProps } from "../../panels/registry";
import { ApproveDialog, useApproveHere } from "../../jobs/ApproveHere";
import { Button, Skeleton, cx } from "../../ui";
import { useServerWord } from "./brand";

/**
 * Jellyfin's People, Devices, Activity and System (logs) tabs; plugins have their own tab now
 * (JellyfinManage.tsx). People and Devices change through plans you
 * approve (disable, enable, library access and downloads, remove; sign out a device); an
 * administrator is never disabled or removed from here. Passwords, API keys and server settings
 * stay in Jellyfin.
 */

function useJellyfin<T>(
  serviceId: string,
  view: string,
  q: Record<string, string | number | undefined> = {},
  enabled = true,
) {
  const params = new URLSearchParams(
    Object.entries(q)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  return useQuery({
    // Under "dashboard": a finished plan refreshes it with the rest of the panel.
    queryKey: ["dashboard", serviceId, "jellyfin", view, params],
    queryFn: () =>
      api<T & { sample?: boolean }>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/jellyfin/${view}${params ? `?${params}` : ""}`,
      ),
    enabled,
    staleTime: 20_000,
  });
}

const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.78rem] text-muted hover:border-gold/50 hover:text-ink disabled:opacity-50";

interface User {
  id: string;
  name: string;
  admin: boolean;
  disabled: boolean;
  allLibraries: boolean;
  libraries: string[];
  downloads: boolean;
  lastSeen?: string;
}

function Access({
  u,
  libraries,
  act,
}: {
  u: User;
  libraries: { id: string; name: string }[];
  act: ReturnType<typeof useApproveHere>;
}) {
  const [all, setAll] = useState(u.allLibraries);
  const [picked, setPicked] = useState<string[]>(u.libraries);
  const [downloads, setDownloads] = useState(u.downloads);
  return (
    <div
      className="mt-2 w-full space-y-2 rounded-xl border border-line bg-bg/50 p-3"
      data-testid="jf-access"
    >
      <label className="inline-flex min-h-9 items-center gap-2 text-[0.82rem] text-ink">
        <input
          type="checkbox"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
          data-hearth-target={`jf-user:${u.id}:all`}
        />
        All libraries
      </label>
      {!all && (
        <div className="flex flex-wrap gap-x-4">
          {libraries.map((l) => (
            <label
              key={l.id}
              className="inline-flex min-h-9 items-center gap-2 text-[0.8rem] text-ink"
            >
              <input
                type="checkbox"
                checked={picked.includes(l.id)}
                onChange={(e) =>
                  setPicked((p) => (e.target.checked ? [...p, l.id] : p.filter((x) => x !== l.id)))
                }
                data-hearth-target={`jf-user:${u.id}:lib:${l.name}`}
              />
              {l.name}
            </label>
          ))}
        </div>
      )}
      <label className="inline-flex min-h-9 items-center gap-2 text-[0.82rem] text-ink">
        <input
          type="checkbox"
          checked={downloads}
          onChange={(e) => setDownloads(e.target.checked)}
          data-hearth-target={`jf-user:${u.id}:downloads`}
        />
        Allow downloads
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          tone="primary"
          disabled={act.busy || (!all && !picked.length)}
          data-hearth-target={`jf-user:${u.id}:save-access`}
          onClick={() =>
            void act.propose(
              "app-jellyfin-control",
              {
                op: "user-access",
                userId: u.id,
                libraryIds: all ? "all" : picked.join(","),
                allowDownloads: downloads,
              },
              `Change ${u.name}'s access`,
            )
          }
        >
          Review access
        </Button>
        {!u.admin && (
          <>
            <button
              type="button"
              className={btn}
              disabled={act.busy}
              data-hearth-target={`jf-user:${u.id}:${u.disabled ? "enable" : "disable"}`}
              onClick={() =>
                void act.propose(
                  "app-jellyfin-control",
                  { op: u.disabled ? "enable-user" : "disable-user", userId: u.id },
                  `${u.disabled ? "Enable" : "Disable"} ${u.name}`,
                )
              }
            >
              {u.disabled ? "Enable account" : "Disable account"}
            </button>
            <button
              type="button"
              className={cx(btn, "hover:border-alert/60 hover:text-alert")}
              disabled={act.busy}
              data-hearth-target={`jf-user:${u.id}:remove`}
              onClick={() =>
                void act.propose(
                  "app-jellyfin-control",
                  { op: "remove-user", userId: u.id },
                  `Remove ${u.name}`,
                )
              }
            >
              Remove
            </button>
          </>
        )}
      </div>
      {u.admin && (
        <p className="text-[0.76rem] text-faint">
          An administrator is never disabled or removed from Hearth; the server needs one to be
          managed at all.
        </p>
      )}
    </div>
  );
}

export function JellyfinPeople({ serviceId, name }: AppViewProps) {
  const server = useServerWord(serviceId);
  const q = useJellyfin<{ users: User[]; libraries: { id: string; name: string }[] }>(
    serviceId,
    "users",
  );
  const act = useApproveHere(serviceId, `From ${server}'s People tab.`);
  const [open, setOpen] = useState<string>();
  if (q.isLoading) return <Skeleton className="h-48" />;
  if (q.error || !q.data)
    return <p className="text-[0.84rem] text-amber">Could not read {name}&apos;s users.</p>;
  const libName = new Map(q.data.libraries.map((l) => [l.id, l.name]));
  return (
    <section className="space-y-3" aria-label={`${name} people`}>
      <ApproveDialog c={act} />
      <ul className="divide-y divide-line" data-testid="jf-users" data-hearth-target="people:list">
        {q.data.users.map((u) => (
          <li
            key={u.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[0.86rem]"
            data-testid="jf-user"
            data-hearth-target={`jf-user:${u.id}`}
          >
            <UserRound strokeWidth={1.5} className="h-4 w-4 shrink-0 text-faint" />
            <span className="min-w-0 flex-1">
              <span className="inline-flex items-center gap-1.5 text-ink">
                {u.name}
                {u.admin && (
                  <ShieldCheck
                    strokeWidth={1.5}
                    className="h-3.5 w-3.5 text-gold"
                    aria-label="Administrator"
                  />
                )}
                {u.disabled && <span className="text-[0.72rem] text-amber">disabled</span>}
              </span>
              <span className="block text-[0.76rem] text-faint">
                {[
                  u.allLibraries
                    ? "All libraries"
                    : u.libraries.map((id) => libName.get(id) ?? id).join(", ") || "No libraries",
                  u.downloads ? "downloads on" : "",
                  u.lastSeen ? `seen ${ago(u.lastSeen)}` : "never signed in",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
            <button
              type="button"
              aria-expanded={open === u.id}
              className={btn}
              onClick={() => setOpen(open === u.id ? undefined : u.id)}
              data-hearth-target={`jf-user:${u.id}:open`}
            >
              Change access
            </button>
            {open === u.id && <Access u={u} libraries={q.data!.libraries} act={act} />}
          </li>
        ))}
      </ul>
      <p className="text-[0.76rem] text-faint">
        Passwords stay in {server} (they are credentials).
      </p>
    </section>
  );
}

export function JellyfinDevices({ serviceId, name }: AppViewProps) {
  const server = useServerWord(serviceId);
  const q = useJellyfin<{
    devices: { id: string; name: string; app: string; user?: string; lastSeen?: string }[];
  }>(serviceId, "devices");
  const act = useApproveHere(serviceId, `From ${server}'s Devices tab.`);
  if (q.isLoading) return <Skeleton className="h-48" />;
  if (q.error || !q.data)
    return <p className="text-[0.84rem] text-amber">Could not read {name}&apos;s devices.</p>;
  return (
    <section className="space-y-3" aria-label={`${name} devices`}>
      <ApproveDialog c={act} />
      {q.data.devices.length === 0 ? (
        <p className="text-[0.84rem] text-muted">No devices are signed in.</p>
      ) : (
        <ul
          className="divide-y divide-line"
          data-testid="jf-devices"
          data-hearth-target="devices:list"
        >
          {q.data.devices.map((d) => (
            <li
              key={d.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[0.86rem]"
              data-testid="jf-device"
            >
              <Smartphone strokeWidth={1.5} className="h-4 w-4 shrink-0 text-faint" />
              <span className="min-w-0 flex-1">
                <span className="text-ink">{d.name}</span>
                <span className="block text-[0.76rem] text-faint">
                  {[d.app, d.user, d.lastSeen ? `active ${ago(d.lastSeen)}` : ""]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <button
                type="button"
                className={btn}
                disabled={act.busy}
                data-hearth-target={`jf-device:${d.id}:sign-out`}
                onClick={() =>
                  void act.propose(
                    "app-jellyfin-control",
                    { op: "sign-out-device", deviceId: d.id },
                    `Sign out ${d.name}`,
                  )
                }
              >
                Sign out
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function JellyfinActivity({ serviceId, name }: AppViewProps) {
  const [page, setPage] = useState(1);
  const q = useJellyfin<{
    entries: { id: number; text: string; detail?: string; at?: string; level?: string }[];
    total: number;
  }>(serviceId, "activity", { page });
  if (q.isLoading) return <Skeleton className="h-48" />;
  if (q.error || !q.data)
    return <p className="text-[0.84rem] text-amber">Could not read {name}&apos;s activity.</p>;
  const pages = Math.max(1, Math.ceil(q.data.total / 50));
  return (
    <section className="space-y-3" aria-label={`${name} activity`}>
      <ul
        className="divide-y divide-line"
        data-testid="jf-activity"
        data-hearth-target="activity:list"
      >
        {q.data.entries.map((e) => (
          <li key={e.id} className="py-2 text-[0.84rem]">
            <p
              className={cx(
                "text-ink",
                e.level === "Error" && "text-alert",
                e.level === "Warning" && "text-amber",
              )}
            >
              {e.text}
            </p>
            <p className="text-[0.74rem] text-faint">
              {[e.detail, e.at ? ago(e.at) : ""].filter(Boolean).join(" · ")}
            </p>
          </li>
        ))}
      </ul>
      {pages > 1 && (
        <div className="flex items-center gap-2 text-[0.8rem] text-muted">
          <button
            type="button"
            className={btn}
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            Newer
          </button>
          <span>
            Page {page} of {pages}
          </span>
          <button
            type="button"
            className={btn}
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
          >
            Older
          </button>
        </div>
      )}
    </section>
  );
}

export function JellyfinSystem({ serviceId, name }: AppViewProps) {
  const logs = useJellyfin<{ files: { name: string; size: number; modified?: string }[] }>(
    serviceId,
    "logs",
  );
  const [file, setFile] = useState<string>();
  const log = useJellyfin<{ lines: string[]; total: number }>(
    serviceId,
    "log",
    { name: file },
    Boolean(file),
  );
  return (
    <section className="space-y-4" aria-label={`${name} system`}>
      <div>
        <p className="eyebrow mb-1">Logs (keys hidden)</p>
        {logs.isLoading ? (
          <Skeleton className="h-16" />
        ) : (
          <select
            className="min-h-10 max-w-full rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink"
            value={file ?? ""}
            onChange={(e) => setFile(e.target.value || undefined)}
            aria-label="Log file"
            data-hearth-target="jf-system:log"
          >
            <option value="">Choose a log</option>
            {(logs.data?.files ?? []).map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
                {f.modified ? ` (${ago(f.modified)})` : ""}
              </option>
            ))}
          </select>
        )}
        {file && (
          <pre
            className="mt-2 max-h-96 overflow-auto rounded-xl border border-line bg-bg/60 p-3 text-[0.72rem] leading-relaxed whitespace-pre-wrap text-muted"
            data-testid="jf-log"
          >
            {log.isLoading ? "Reading..." : (log.data?.lines ?? []).join("\n")}
          </pre>
        )}
      </div>
    </section>
  );
}
