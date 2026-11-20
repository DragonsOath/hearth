import { useMemo, useState } from "react";
import type { Blocker } from "@dragon-control/core";
import { BlockerCard } from "../blockers/BlockerCard";
import { Globe, Shield } from "lucide-react";
import { api } from "../../data/api";
import { ago } from "../../lib/format";
import { Button, Skeleton, cx } from "../ui";
import { ChangeCard, useConfirmedChange } from "./ConfirmedChange";
import { useLiveQuery } from "../panels/lifecycle";

/**
 * Gluetun from Hearth: whether the VPN is up, which server it uses and the internet address the
 * world sees, which containers send their traffic through it, and moving it to another server.
 * Moving is a protected plan: you confirm it is you, Hearth backs up the Compose file, switches,
 * checks the new address, and puts it back on its own if the VPN does not come up.
 */

interface Vpn {
  container: string;
  status: string;
  health?: string;
  since?: string;
  restarts: number;
  current: { ip: string; name?: string; country?: string; city?: string } | null;
  exitAddress: string | null;
  routed: string[];
  servers: {
    name: string;
    country: string;
    city: string;
    portForward: boolean;
    streaming: boolean;
  }[];
}

export function GluetunDashboard({ serviceId, name }: { serviceId: string; name: string }) {
  const q = useLiveQuery({
    queryKey: ["dashboard", serviceId, "vpn"],
    queryFn: () =>
      api<{ data?: Vpn; error?: { message: string; blocker?: Blocker } }>(
        "GET",
        `/api/services/${serviceId}/vpn`,
      ),
    refetchInterval: 60_000,
  });
  const c = useConfirmedChange(serviceId);
  const [country, setCountry] = useState("");
  const [server, setServer] = useState("");
  const [only, setOnly] = useState<"all" | "pf" | "streaming">("all");
  const d = q.data?.data;
  const countries = useMemo(
    () => [...new Set((d?.servers ?? []).map((s) => s.country))].sort(),
    [d],
  );
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error || q.data?.error) {
    const blocker = q.data?.error?.blocker;
    return (
      <div className="space-y-3">
        <div
          className="rounded-xl border border-amber/40 p-4 text-[0.88rem]"
          data-testid="vpn-error"
        >
          <p className="text-amber">{name} could not be read right now.</p>
          <p className="mt-1 text-muted">{q.data?.error?.message ?? q.error?.message}</p>
        </div>
        {blocker && (
          <BlockerCard blocker={blocker} serviceName={name} onResolved={() => void q.refetch()} />
        )}
      </div>
    );
  }
  if (!d) return null;
  const up = d.status === "running" && d.health !== "unhealthy";
  const choices = d.servers
    .filter((s) => !country || s.country === country)
    .filter((s) => (only === "pf" ? s.portForward : only === "streaming" ? s.streaming : true))
    .slice(0, 200);
  return (
    <section
      className="@container space-y-4"
      data-testid="vpn-dashboard"
      aria-label={`${name}: VPN`}
    >
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        {(
          [
            [
              "VPN",
              up ? "Up" : d.status === "running" ? "Unhealthy" : "Down",
              d.since ? `since ${ago(d.since)}` : d.status,
            ],
            ["Seen as", d.exitAddress ?? "No connection", "the address the internet sees"],
            [
              "Server",
              d.current?.name ?? d.current?.ip ?? "Unknown",
              d.current?.city ? `${d.current.city}, ${d.current.country}` : "",
            ],
            ["Restarts", `${d.restarts}`, "since it was created"],
          ] as const
        ).map(([label, value, sub]) => (
          <div key={label} className="min-w-0 rounded-xl border border-line bg-bg/50 p-3">
            <p className="text-[0.72rem] tracking-wide text-faint uppercase">{label}</p>
            <p
              className={cx(
                "text-[1.2rem] break-words text-ink tabular",
                label === "VPN" && (up ? "text-live" : "text-alert"),
                label === "Seen as" && !d.exitAddress && "text-alert",
              )}
              data-testid={
                label === "VPN"
                  ? "vpn-state"
                  : label === "Seen as"
                    ? "vpn-exit"
                    : label === "Server"
                      ? "vpn-server"
                      : undefined
              }
            >
              {value}
            </p>
            <p className="text-[0.74rem] text-faint">{sub}</p>
          </div>
        ))}
      </div>

      <div>
        <p className="mb-1.5 text-[0.72rem] tracking-wide text-faint uppercase">
          Traffic through the VPN · {d.routed.length}
        </p>
        {d.routed.length ? (
          <ul className="flex flex-wrap gap-2" data-testid="vpn-routed">
            {d.routed.map((r) => (
              <li
                key={r}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[0.8rem] text-ink"
              >
                <Shield strokeWidth={1.5} className="h-3.5 w-3.5 text-live" aria-hidden /> {r}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[0.84rem] text-muted">
            No running container sends its traffic through {name}.
          </p>
        )}
        {d.routed.length > 0 && (
          <p className="mt-1.5 text-[0.76rem] text-faint">
            If the VPN drops, these lose their connection instead of using your home address.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-[0.72rem] tracking-wide text-faint uppercase">Move to another server</p>
        {d.servers.length ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (server)
                void c.propose("vpn-switch-server", { server }, `Switch ${name} to ${server}`);
            }}
          >
            <label className="grid gap-1 text-[0.76rem] text-muted">
              Country
              <select
                value={country}
                onChange={(e) => {
                  setCountry(e.target.value);
                  setServer("");
                }}
                className="min-h-10 rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink"
                data-testid="vpn-country"
              >
                <option value="">Any</option>
                {countries.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-[0.76rem] text-muted">
              Kind
              <select
                value={only}
                onChange={(e) => setOnly(e.target.value as typeof only)}
                className="min-h-10 rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink"
              >
                <option value="all">All servers</option>
                <option value="pf">Port forwarding</option>
                <option value="streaming">Streaming</option>
              </select>
            </label>
            <label className="grid min-w-0 flex-1 gap-1 text-[0.76rem] text-muted">
              Server
              <select
                value={server}
                onChange={(e) => setServer(e.target.value)}
                className="min-h-10 min-w-0 rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink"
                data-testid="vpn-pick"
              >
                <option value="">Choose a server ({choices.length})</option>
                {choices.map((s) => (
                  <option key={s.name} value={s.name} disabled={s.name === d.current?.name}>
                    {s.name}, {s.city}
                    {s.portForward ? " · port forwarding" : ""}
                    {s.name === d.current?.name ? " (now)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <Button tone="primary" type="submit" disabled={!server} data-testid="vpn-switch">
              <Globe className="h-4 w-4" /> Switch
            </Button>
          </form>
        ) : (
          <p className="text-[0.84rem] text-muted">
            Gluetun has no ProtonVPN server list to choose from.
          </p>
        )}
        <p className="text-[0.76rem] text-faint">
          Switching restarts {name}
          {d.routed.length ? ` and ${d.routed.join(", ")}` : ""} (about a minute offline). You
          confirm it is you first.
        </p>
        <ChangeCard c={c} />
      </div>
      <p className="text-[0.74rem] text-faint">{d.container} · live, every 60 s</p>
    </section>
  );
}
