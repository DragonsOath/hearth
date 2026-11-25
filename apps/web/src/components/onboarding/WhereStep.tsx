import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DiscoveryReport } from "@dragon-control/core";
import { useAdopt, useFindMachines, useScanRemote, type FoundMachine } from "../../data/api";
import { Button, StatusDot, cx } from "../ui";

/**
 * The first question after sign-in: where the owner's apps and files live. A NAS or another
 * computer is found right here (its address, or "Find it for me" on the home network) and its
 * apps adopted, so they are in Hearth before the home screen. Starting from nothing goes to
 * Build my setup. Every part can be skipped.
 */

export type Where = "here" | "nas" | "other" | "new";

const CHOICES: { id: Where; title: string; line: string }[] = [
  {
    id: "here",
    title: "On this computer",
    line: "Your apps (Plex, the arr apps and the rest) run on the computer Hearth is on.",
  },
  {
    id: "nas",
    title: "On a NAS",
    line: "Synology, QNAP, TrueNAS, Unraid, OpenMediaVault, or I'm not sure.",
  },
  {
    id: "other",
    title: "On another computer or server",
    line: "A different PC, mini PC or server on your home network.",
  },
  {
    id: "new",
    title: "I'm starting from nothing",
    line: "New to this? Say what you'd love to do and get a plan that suits your computer.",
  },
];

const field =
  "mt-2 min-h-11 w-full rounded-lg border border-line bg-panel px-3 text-[0.95rem] text-ink focus:border-gold/60 focus:outline-none";

export function WhereStep({
  picked,
  onPick,
  onDone,
}: {
  picked?: Where;
  /** A choice was made: "here" and "new" move on at once. */
  onPick: (where: Where) => void;
  /** The NAS or other machine was added, or skipped: move on. */
  onDone: () => void;
}) {
  const [explain, setExplain] = useState(false);
  const machine = picked === "nas" || picked === "other" ? picked : undefined;
  return (
    <>
      <p className="mb-6 text-[0.92rem] leading-relaxed text-muted">
        So Hearth can find what you already have, or help you start.
      </p>
      <div className="grid gap-3 sm:grid-cols-2" role="group" aria-label="Where your apps live">
        {CHOICES.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onPick(c.id)}
            aria-pressed={picked === c.id}
            className={cx(
              "flex min-h-24 w-full flex-col items-start gap-1 rounded-xl border p-4 text-left transition-colors",
              picked === c.id
                ? "border-gold bg-gold/10"
                : "border-line-strong hover:border-gold/60",
            )}
            data-testid={`where-${c.id}`}
          >
            <span className="text-[1.05rem] text-ink">{c.title}</span>
            <span className="text-[0.85rem] leading-relaxed text-muted">{c.line}</span>
          </button>
        ))}
      </div>
      <p className="mt-3 text-[0.82rem] text-faint">
        <button
          type="button"
          className="text-gold underline underline-offset-2"
          aria-expanded={explain}
          onClick={() => setExplain((v) => !v)}
          data-testid="where-not-sure"
        >
          I&apos;m not sure what a NAS is
        </button>
      </p>
      {explain && (
        <p
          className="mt-2 text-[0.85rem] leading-relaxed text-ink"
          data-testid="where-nas-explained"
        >
          A NAS is a box of drives on your home network that keeps your files and can run apps, like
          a Synology or QNAP. No box like that? Pick &ldquo;On this computer&rdquo;.
        </p>
      )}
      {machine && <MachineFinder key={machine} kind={machine} onDone={onDone} />}
      <p className="mt-6 text-[0.8rem] text-faint">
        Hearth is free. You bring your own AI (Ollama is free and runs at home) and, for automatic
        downloads, your own VPN. You can change any of this later.
      </p>
    </>
  );
}

/** The NAS or other machine: its address (or found for you), its apps, and adding them. */
function MachineFinder({ kind, onDone }: { kind: "nas" | "other"; onDone: () => void }) {
  const [address, setAddress] = useState("");
  const [name, setName] = useState(kind === "nas" ? "NAS" : "Server");
  const find = useFindMachines();
  const scan = useScanRemote();
  const [report, setReport] = useState<DiscoveryReport | null>(null);

  const check = (addr: string, as: string) => {
    setAddress(addr);
    setName(as);
    scan.mutate({ address: addr, name: as }, { onSuccess: setReport });
  };
  const thing = kind === "nas" ? "your NAS" : "that computer";

  return (
    <section
      className="mt-6 rounded-xl border border-line-strong p-4 sm:p-5"
      aria-labelledby="where-machine"
    >
      <h2 id="where-machine" className="text-[1.05rem] text-ink">
        {kind === "nas" ? "Find your NAS" : "Find that computer"}
      </h2>
      {report ? (
        <MachineResults report={report} onDone={onDone} onBack={() => setReport(null)} />
      ) : (
        <>
          <p className="mt-1 text-[0.85rem] leading-relaxed text-muted">
            Type {thing}&apos;s address (it looks like 192.168.1.20, and your router&apos;s list of
            devices shows it), or let Hearth look on your home network.
          </p>
          <form
            className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr]"
            onSubmit={(e) => {
              e.preventDefault();
              check(address.trim(), name.trim() || (kind === "nas" ? "NAS" : "Server"));
            }}
          >
            <label className="block text-[0.85rem] text-muted">
              Address
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="192.168.1.20"
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
                required
                maxLength={60}
                className={field}
              />
            </label>
            <div className="flex flex-wrap gap-3 sm:col-span-2">
              <Button type="submit" tone="primary" disabled={scan.isPending}>
                {scan.isPending ? "Checking" : "Check it"}
              </Button>
              <Button
                type="button"
                disabled={find.isPending || scan.isPending}
                onClick={() => find.mutate()}
                data-testid="where-find"
              >
                {find.isPending ? "Looking on your network" : "Find it for me"}
              </Button>
            </div>
          </form>
          {find.isPending && (
            <p role="status" className="mt-3 text-[0.85rem] text-muted">
              Looking at the devices on your home network. This takes about 20 seconds, and changes
              nothing.
            </p>
          )}
          {find.data &&
            (find.data.machines.length ? (
              <div className="mt-4" data-testid="where-found">
                <p className="text-[0.85rem] text-muted">
                  Found on your network. Pick {kind === "nas" ? "your NAS" : "the one you mean"}:
                </p>
                <ul className="mt-2 grid gap-2">
                  {find.data.machines.map((m) => (
                    <li key={m.address}>
                      <FoundButton
                        machine={m}
                        disabled={scan.isPending}
                        onPick={() => check(m.address, m.nas ? "NAS" : name.trim() || "Server")}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p role="status" className="mt-3 text-[0.85rem] text-warn">
                Hearth didn&apos;t find a NAS or app server on your home network. Type its address
                instead, or skip this for now.
              </p>
            ))}
          {(scan.error ?? find.error) && (
            <p role="alert" className="mt-3 text-[0.88rem] text-bad">
              {(scan.error ?? find.error)!.message}
            </p>
          )}
          <p className="mt-4 text-[0.82rem]">
            <button
              type="button"
              className="text-gold underline underline-offset-2"
              onClick={onDone}
              data-testid="where-later"
            >
              Skip this for now
            </button>
            <span className="text-faint"> (Discover can find it any time)</span>
          </p>
        </>
      )}
    </section>
  );
}

function FoundButton({
  machine,
  onPick,
  disabled,
}: {
  machine: FoundMachine;
  onPick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      className="flex min-h-11 w-full flex-col items-start rounded-lg border border-line-strong px-3 py-2 text-left hover:border-gold/60"
    >
      <span className="text-[0.95rem] text-ink">
        {machine.nas ?? "A computer"} <span className="text-muted">at {machine.address}</span>
      </span>
      {machine.apps.length > 0 && (
        <span className="text-[0.8rem] text-muted">Runs {machine.apps.join(", ")}</span>
      )}
    </button>
  );
}

/** What answered there, ticked by default, and adding it. */
function MachineResults({
  report,
  onDone,
  onBack,
}: {
  report: DiscoveryReport;
  onDone: () => void;
  onBack: () => void;
}) {
  const adopt = useAdopt();
  const qc = useQueryClient();
  const [picked, setPicked] = useState(
    () => new Set(report.findings.filter((f) => f.selectedByDefault).map((f) => f.key)),
  );
  const toggle = (key: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const add = () =>
    adopt.mutate(
      {
        reportId: report.id,
        selections: report.findings
          .filter((f) => picked.has(f.key))
          .map((f) => ({ key: f.key, name: f.name })),
      },
      {
        onSuccess: () => {
          void qc.invalidateQueries({ queryKey: ["credentials"] });
          onDone();
        },
      },
    );

  return (
    <div data-testid="where-results">
      <p className="mt-1 text-[0.85rem] text-muted">
        {report.findings.length
          ? `Found at ${report.host.address}. Hearth will watch what's ticked. Each app needs its key once, later, to show everything.`
          : (report.notes[0] ?? `Nothing Hearth knows answered at ${report.host.address}.`)}
      </p>
      {report.findings.length > 0 && (
        <ul className="mt-3 divide-y divide-line">
          {report.findings.map((f) => (
            <li key={f.key}>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 py-2">
                <input
                  type="checkbox"
                  checked={picked.has(f.key)}
                  onChange={() => toggle(f.key)}
                  className="h-5 w-5 cursor-pointer accent-[var(--color-gold)]"
                />
                <span className="flex-1 text-[0.95rem] text-ink">{f.name}</span>
                <span className="flex items-center gap-2 text-[0.8rem] text-faint">
                  <StatusDot health={f.health} />
                  {f.localUrl?.replace(/^https?:\/\//, "")}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex flex-wrap gap-3">
        {report.findings.length > 0 && (
          <Button tone="primary" disabled={adopt.isPending || !picked.size} onClick={add}>
            {adopt.isPending ? "Adding" : `Add ${picked.size} and continue`}
          </Button>
        )}
        <Button onClick={onBack}>Try another address</Button>
      </div>
      {adopt.error && (
        <p role="alert" className="mt-3 text-[0.85rem] text-bad">
          {adopt.error.message}
        </p>
      )}
    </div>
  );
}
