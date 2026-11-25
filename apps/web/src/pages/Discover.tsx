import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Check, Minus } from "lucide-react";
import type { DiscoveryFinding, DiscoveryReport, FindingGroup } from "@dragon-control/core";
import { api, useAdopt, useLatestScan, useScan, useScanRemote, useWorkspace } from "../data/api";
import { usePcs } from "../data/pcs";
import {
  Button,
  Monogram,
  PageHeader,
  Panel,
  Section,
  Skeleton,
  StatusDot,
  Tag,
  cx,
} from "../components/ui";
import { tb } from "../lib/format";
import { KeysOffer } from "../components/credentials/KeysOffer";
import { useQuery, useQueryClient } from "@tanstack/react-query";

const groups: { id: FindingGroup; title: string; hint: string }[] = [
  { id: "recognised", title: "Recognised", hint: "Apps Hearth knows how to look after." },
  {
    id: "unrecognised-web",
    title: "Needs a name",
    hint: "Web apps it does not know yet. Name them so they read well.",
  },
  {
    id: "supporting",
    title: "Supporting",
    hint: "Databases, VPNs, and helpers other apps rely on. Worth watching, nothing to open.",
  },
  {
    id: "stopped",
    title: "Stopped",
    hint: "Not running right now, so left out unless you choose them.",
  },
];

const reads = [
  "This machine: processor, memory, drives, and how long it has been up",
  "Docker containers: names, images, ports, and health",
  "A quick check for common apps installed directly on this machine",
];
const never = [
  "Start, stop, or change anything",
  "Read passwords, API keys, or other settings inside your apps (afterwards it asks if you want your keys found)",
  "Look at your files",
];

function Intro({
  onScan,
  scanning,
  error,
  onRemote,
}: {
  onScan: () => void;
  scanning: boolean;
  error?: string;
  onRemote: () => void;
}) {
  return (
    <>
      <div className="mb-10 grid gap-8 sm:grid-cols-2">
        <div>
          <p className="eyebrow mb-4">It reads</p>
          <ul className="space-y-3">
            {reads.map((r) => (
              <li key={r} className="flex gap-3 text-[0.9rem] leading-relaxed text-ink">
                <Check strokeWidth={1.25} className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
                {r}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="eyebrow mb-4">It never</p>
          <ul className="space-y-3">
            {never.map((r) => (
              <li key={r} className="flex gap-3 text-[0.9rem] leading-relaxed text-muted">
                <Minus strokeWidth={1.25} className="mt-0.5 h-4 w-4 shrink-0 text-faint" />
                {r}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <Button tone="primary" onClick={onScan} disabled={scanning}>
        {scanning ? "Looking around" : "Scan this machine"}
      </Button>
      {scanning && (
        <div className="mt-10 space-y-3" aria-busy="true" aria-label="Scanning">
          <p className="text-[0.85rem] text-muted">This usually takes a few seconds.</p>
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      )}
      {error && (
        <p role="alert" className="mt-4 text-[0.88rem] text-bad">
          {error}
        </p>
      )}
      {!scanning && <AnotherMachine onDone={onRemote} />}
    </>
  );
}

function AnotherMachine({ onDone }: { onDone: () => void }) {
  const scan = useScanRemote();
  const [address, setAddress] = useState("");
  const [name, setName] = useState("");
  const field =
    "mt-2 min-h-11 w-full rounded-lg border border-line bg-panel px-3 text-[0.95rem] text-ink focus:border-gold/60 focus:outline-none";
  return (
    <Panel className="mt-12 p-6 sm:p-8">
      <section aria-labelledby="another-machine">
        <h2 id="another-machine" className="font-display text-[1.6rem] leading-none text-ink">
          Another machine
        </h2>
        <p className="mt-3 max-w-xl text-[0.88rem] leading-relaxed text-muted">
          For a NAS (Synology, QNAP, TrueNAS, Unraid) or another computer that keeps some apps.
          Nothing is installed there: Hearth reads which apps answer at its address, and the
          NAS&apos;s own page, and keeps checking them. It cannot restart them or see that
          machine&apos;s drives.
        </p>
        <form
          className="mt-6 grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            scan.mutate({ address, name }, { onSuccess: onDone });
          }}
        >
          <label className="block text-[0.85rem] text-muted">
            Address
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="IP address"
              required
              maxLength={253}
              autoCapitalize="off"
              spellCheck={false}
              className={field}
            />
          </label>
          <label className="block text-[0.85rem] text-muted">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name"
              required
              maxLength={60}
              className={field}
            />
          </label>
          <Button type="submit" disabled={scan.isPending}>
            {scan.isPending ? "Checking" : "Check this machine"}
          </Button>
        </form>
        {scan.error && (
          <p role="alert" className="mt-4 text-[0.88rem] text-bad">
            {scan.error.message}
          </p>
        )}
      </section>
    </Panel>
  );
}

function FindingRow({
  finding,
  selected,
  name,
  onToggle,
  onRename,
}: {
  finding: DiscoveryFinding;
  selected: boolean;
  name: string;
  onToggle: () => void;
  onRename: (name: string) => void;
}) {
  const checkboxId = `pick-${finding.key}`;
  const address = finding.localUrl?.replace(/^https?:\/\//, "");
  return (
    <li className="flex items-start gap-4 py-4">
      {finding.removed ? (
        // Removed by you: a scan never adds it back, so there is nothing to tick.
        <span className="flex min-h-11 min-w-11 items-center justify-center" aria-hidden="true" />
      ) : (
        <label
          htmlFor={checkboxId}
          className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center"
        >
          <input
            id={checkboxId}
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            aria-label={`Include ${name || finding.name}`}
            className="h-5 w-5 cursor-pointer accent-[var(--color-gold)]"
          />
        </label>
      )}
      <Monogram name={name || finding.name} image={finding.image} className="mt-1 hidden sm:flex" />
      <div className="min-w-0 flex-1">
        {finding.group === "unrecognised-web" && !finding.removed ? (
          <>
            <label className="sr-only" htmlFor={`name-${finding.key}`}>
              Name for {finding.sourceName}
            </label>
            <input
              id={`name-${finding.key}`}
              value={name}
              maxLength={60}
              onChange={(e) => onRename(e.target.value)}
              className="min-h-11 w-full max-w-xs rounded-lg border border-line bg-panel px-3 text-[0.95rem] text-ink focus:border-gold/60 focus:outline-none"
            />
          </>
        ) : (
          <p className={cx("pt-2 text-[0.95rem]", selected ? "text-ink" : "text-muted")}>
            {finding.name}
            {finding.removed ? (
              <span className="ml-2 text-[0.78rem] text-faint">Removed by you</span>
            ) : (
              !selected && <span className="sr-only"> (not included)</span>
            )}
          </p>
        )}
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[0.8rem] text-faint">
          <StatusDot health={finding.health} />
          <span className="truncate">{address ?? "No web interface"}</span>
          {finding.localOnly && <span>· this machine only</span>}
          {finding.key.startsWith("process:") && <span>· installed directly</span>}
        </p>
        <p className="mt-1 text-[0.78rem] leading-relaxed text-faint">{finding.reason}</p>
      </div>
    </li>
  );
}

function Results({
  report,
  replacing,
  onAdopted,
  pc,
}: {
  report: DiscoveryReport;
  replacing: "demo" | "real" | "empty";
  onAdopted: () => void;
  /** A joined PC being discovered from your Hearth. */
  pc?: string;
}) {
  const adopt = useAdopt(pc);
  const qc = useQueryClient();
  const [picked, setPicked] = useState(
    () => new Set(report.findings.filter((f) => f.selectedByDefault).map((f) => f.key)),
  );
  const [names, setNames] = useState<Record<string, string>>(() =>
    Object.fromEntries(report.findings.map((f) => [f.key, f.name])),
  );
  const byGroup = useMemo(
    () => groups.map((g) => ({ ...g, items: report.findings.filter((f) => f.group === g.id) })),
    [report],
  );
  const toggle = (key: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const submit = () =>
    adopt.mutate(
      {
        reportId: report.id,
        selections: report.findings
          .filter((f) => picked.has(f.key))
          .map((f) => ({ key: f.key, name: names[f.key]?.trim() || f.name })),
      },
      {
        onSuccess: () => {
          void qc.invalidateQueries({ queryKey: ["credentials"] });
          onAdopted();
        },
      },
    );

  const disk = report.host.volumes.reduce((s, v) => s + v.totalTb, 0);
  const remote = report.host.connection === "network";

  return (
    <>
      <Panel className="mb-12 p-6 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="font-display text-[2rem] leading-none text-ink">{report.host.name}</p>
            <p className="mt-2 text-[0.85rem] text-muted">
              {report.host.os} · {report.host.address}
            </p>
          </div>
          <Tag tone="gold">{remote ? "Another machine" : "This machine"}</Tag>
        </div>
        <dl className="mt-6 grid grid-cols-2 gap-5 border-t border-line pt-5 sm:grid-cols-4">
          {(remote
            ? [
                ["Found", `${report.findings.length}`],
                ["Checked", "Over the network"],
              ]
            : [
                ["Found", `${report.findings.length}`],
                ["Recognised", `${report.findings.filter((f) => f.recognised).length}`],
                ["Drives", `${report.host.volumes.length} · ${tb(disk)}`],
                [
                  "Docker",
                  report.docker.available
                    ? `Version ${report.docker.version ?? "?"}`
                    : "Not available",
                ],
              ]
          ).map(([k, v]) => (
            <div key={k}>
              <dt className="text-[0.75rem] text-faint">{k}</dt>
              <dd className="mt-1 text-[0.9rem] text-ink tabular">{v}</dd>
            </div>
          ))}
        </dl>
        {report.notes.map((n) => (
          <p key={n} role="status" className="mt-4 text-[0.85rem] text-warn">
            {n}
          </p>
        ))}
      </Panel>

      {byGroup
        .filter((g) => g.items.length)
        .map((g) => (
          <Section key={g.id} title={`${g.title} · ${g.items.length}`}>
            <p className="-mt-1 mb-2 text-[0.82rem] text-muted">{g.hint}</p>
            <ul className="divide-y divide-line">
              {g.items.map((f) => (
                <FindingRow
                  key={f.key}
                  finding={f}
                  selected={picked.has(f.key)}
                  name={names[f.key] ?? f.name}
                  onToggle={() => toggle(f.key)}
                  onRename={(n) => setNames((all) => ({ ...all, [f.key]: n }))}
                />
              ))}
            </ul>
          </Section>
        ))}

      <div className="sticky bottom-20 z-10 -mx-5 border-t border-line bg-bg/95 px-5 py-5 backdrop-blur-md sm:-mx-10 sm:px-10 lg:bottom-0 lg:-mx-14 lg:px-14">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[0.82rem] text-muted">
            {replacing === "demo"
              ? "Replaces the sample data. Your name and settings are kept."
              : replacing === "real"
                ? `Updates ${report.host.name} from this scan. Other machines and your settings are kept.`
                : "Your settings are kept."}
          </p>
          {/* Nothing ticked still watches the machine itself: its processor, memory and drives. */}
          <Button tone="primary" onClick={submit} disabled={adopt.isPending}>
            {adopt.isPending
              ? "Saving"
              : picked.size === 0
                ? `Watch ${report.host.name} only`
                : `Adopt ${picked.size} ${picked.size === 1 ? "service" : "services"}`}
          </Button>
        </div>
        {adopt.error && (
          <p role="alert" className="mt-3 text-[0.85rem] text-bad">
            {adopt.error.message}
          </p>
        )}
      </div>
    </>
  );
}

export function DiscoverPage() {
  // ?pc=<id>: a PC that joined your Hearth looks at its own machine (10-30: its numbers on
  // Home come from this).
  const [params] = useSearchParams();
  const pc = params.get("pc") || undefined;
  const pcs = usePcs();
  const pcName = pc ? pcs.data?.pcs.find((p) => p.id === pc)?.name : undefined;
  const latest = useLatestScan(pc);
  const scan = useScan(pc);
  const { data: hereWs } = useWorkspace();
  const pcWs = useQuery({
    queryKey: ["pc-environment", pc],
    queryFn: () =>
      api<{ environment: "demo" | "real" | "empty" }>("GET", `/api/on/${pc}/workspace`),
    enabled: Boolean(pc),
  });
  const ws = pc ? pcWs.data : hereWs;
  const navigate = useNavigate();
  const [fresh, setFresh] = useState(false);
  // After adopting: offer to find the apps' keys before going home. Kept here, since adopting
  // refreshes the scan below and would otherwise reset the page.
  const [adopted, setAdopted] = useState(false);
  const report = fresh ? null : (scan.data ?? latest.data ?? null);

  if (adopted && pc) {
    return (
      <>
        <PageHeader eyebrow="Discovery" title={`${pcName ?? "That PC"}'s systems are in`} />
        <Button onClick={() => navigate("/")}>Back to Home</Button>
      </>
    );
  }
  if (adopted) {
    return (
      <>
        <PageHeader eyebrow="Discovery" title="Your systems are in" />
        <KeysOffer onDone={() => navigate("/")} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Discovery"
        title={pc ? `Find the systems on ${pcName ?? "that PC"}` : "Find your systems"}
        subtitle={`Hearth looks at ${pc ? (pcName ?? "that PC") : "this machine"} and its containers, then suggests what to watch. It only reads; nothing on your systems changes.`}
        actions={
          report ? (
            <div className="flex flex-wrap gap-3">
              <Button tone="outline" onClick={() => setFresh(true)}>
                Start over
              </Button>
              {(pc || report.host.connection === "this-machine") && (
                <Button onClick={() => scan.mutate()} disabled={scan.isPending}>
                  {scan.isPending ? "Scanning" : "Scan again"}
                </Button>
              )}
            </div>
          ) : undefined
        }
      />
      {report && !scan.isPending ? (
        <Results
          key={report.id}
          report={report}
          replacing={ws?.environment ?? "empty"}
          onAdopted={() => setAdopted(true)}
          {...(pc ? { pc } : {})}
        />
      ) : (
        <Intro
          onScan={() => scan.mutate(undefined, { onSuccess: () => setFresh(false) })}
          scanning={scan.isPending}
          error={scan.error?.message}
          onRemote={() => setFresh(false)}
        />
      )}
    </>
  );
}
