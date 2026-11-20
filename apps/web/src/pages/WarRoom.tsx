import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../data/api";
import { useSavedTheme } from "../components/AppShell";
import {
  EmberRoom,
  tabKey,
  type Elsewhere,
  type OtherTab,
  type PcTabLook,
} from "../components/ember/EmberRoom";
import { setEngineTarget, store } from "../components/ember/engine";
import { pcLook, usePcs, type PcInfo } from "../data/pcs";
import { CaveProvider } from "../components/shell/cave-context";
import { viewingPcId } from "../lib/viewingPc";
import { usePhone } from "../lib/media";

/** Whether this Hearth has its engine (Claude Code and Codex on this machine). */
export function useEmberLink() {
  return useQuery({
    queryKey: ["engine-health"],
    queryFn: async () => {
      const ok = await api<{ ok: boolean }>("GET", "/api/engine/health").then(
        (r) => r.ok,
        () => false,
      );
      return { configured: ok, reachable: ok };
    },
    staleTime: 30_000,
  });
}

/**
 * The War Room, full screen: EMBER's control center (the real Claude Code and Codex) with Hearth's
 * panels. Without EMBER on this machine it says so plainly; Hearth's own chat still works from
 * every page.
 */
export function WarRoomPage() {
  useSavedTheme();
  const link = useEmberLink();
  const phone = usePhone();
  useEffect(() => {
    document.title = "War Room · Hearth";
  }, []);
  // A phone is too small for building (11-13, the owner): the Lair is there instead.
  if (phone)
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg p-6 text-ink">
        <div
          className="w-full max-w-md rounded-2xl border border-gold/30 bg-panel p-6"
          data-testid="war-room-phone"
        >
          <h1 className="font-display text-[1.6rem]">War Room</h1>
          <p className="mt-2 text-muted">
            The War Room is made for building on a tablet or computer. On your phone, Ember is in
            the Lair, beside your systems.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link
              to="/?panels="
              className="flex min-h-11 items-center rounded-full bg-gold px-5 text-[0.9rem] text-bg"
            >
              Open the Lair
            </Link>
            <Link
              to="/"
              className="flex min-h-11 items-center rounded-full border border-gold/40 px-5 text-[0.9rem] text-gold"
            >
              Home
            </Link>
          </div>
        </div>
      </div>
    );
  // Hearth's panels inside the room expect Ember's chat context, as they have on every other page.
  if (link.data?.configured && link.data.reachable)
    return (
      <CaveProvider>
        <WarRoomAcrossPcs />
      </CaveProvider>
    );
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg p-6 text-ink">
      <div
        className="max-w-md rounded-2xl border border-gold/30 bg-panel p-6"
        data-testid="war-room-missing"
      >
        <h1 className="font-display text-[1.6rem]">War Room</h1>
        {link.isLoading ? (
          <p className="mt-2 text-muted">Connecting…</p>
        ) : link.data?.configured ? (
          <p className="mt-2 text-muted">
            The War Room&apos;s engine isn&apos;t answering right now. Hearth may be restarting. Try
            again in a moment.
          </p>
        ) : (
          <p className="mt-2 text-muted">
            The War Room&apos;s engine (Claude Code and Codex on this machine) isn&apos;t running in
            this Hearth.
          </p>
        )}
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={() => void link.refetch()}
            className="min-h-10 rounded-lg border border-gold/50 px-4 text-gold hover:bg-gold/10"
          >
            Try again
          </button>
          <Link
            to="/"
            className="flex min-h-10 items-center rounded-lg border border-line px-4 text-muted hover:text-ink"
          >
            Back to Hearth
          </Link>
        </div>
      </div>
    </div>
  );
}

const lookOf = (pc: PcInfo): PcTabLook => {
  const l = pcLook(pc);
  return { name: pc.name, src: l.src, color: l.color };
};
const readTabs = (pc: string | null): string[] => {
  try {
    return JSON.parse(store.get(tabKey(pc, "tabs")) ?? "[]") as string[];
  } catch {
    return [];
  }
};
const readNames = (pc: string | null): Record<string, string> => {
  try {
    return JSON.parse(store.get(tabKey(pc, "tabnames")) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
};

/**
 * The War Room across every PC in your Hearth (docs/design/ONE_ACCOUNT.md): it works on one PC
 * at a time (the one the open project lives on), with the tabs from every PC side by side, each
 * marked with its PC's icon. Picking a tab on another PC moves the War Room there.
 */
function WarRoomAcrossPcs() {
  const pcsQ = usePcs();
  const qc = useQueryClient();
  // From Home's project cards (?pc=): the War Room opens on the PC the project lives on.
  // Otherwise on the PC this window was opened from (a joined PC's window), then your last pick.
  const [machine, setMachine] = useState<string | null>(() => {
    const asked = new URLSearchParams(window.location.search).get("pc");
    if (asked === null) return viewingPcId() ?? (store.get("ember.machine") || null);
    const pick = asked === "hub" ? null : asked;
    store.set("ember.machine", pick ?? "");
    return pick;
  });
  const [, setTick] = useState(0);
  const data = pcsQ.data;
  const pcs = data?.pcs ?? [];
  // A PC that has left your Hearth: back to this one.
  const current = machine && data && !pcs.some((p) => p.id === machine) ? null : machine;
  setEngineTarget(current);

  const multi = pcs.length > 0 || Boolean(data?.hub.icon);
  const machines = data
    ? [
        { pc: null, look: lookOf(data.hub), online: true },
        ...pcs.map((p) => ({ pc: p.id, look: lookOf(p), online: Boolean(p.online) })),
      ]
    : [];
  // Every other PC's projects, for the Open menu: the War Room shows what is on each PC, not
  // just the tabs you happened to open there.
  const elsewhereMachines = machines.filter((m) => m.pc !== current && m.online);
  const lists = useQueries({
    queries: elsewhereMachines.map((m) => ({
      queryKey: ["engine-projects", m.pc ?? "hub"],
      queryFn: () =>
        api<{ slug: string; name: string; description?: string; last?: string | null }[]>(
          "GET",
          m.pc ? `/api/on/${m.pc}/engine/projects` : "/api/engine/projects",
        ),
      staleTime: 30_000,
    })),
  });
  const elsewhere: Elsewhere[] = elsewhereMachines.map((m, i) => ({
    pc: m.pc,
    look: m.look,
    projects: (lists[i]?.data ?? [])
      .filter((p) => p.slug !== "sandbox")
      .map((p) => ({ slug: p.slug, name: p.name, description: p.description ?? "" })),
  }));
  if (!data && pcsQ.isLoading) return null;
  const others: OtherTab[] = multi
    ? machines
        .filter((m) => m.pc !== current)
        .flatMap((m) => {
          const names = readNames(m.pc);
          return readTabs(m.pc).map((slug) => ({
            pc: m.pc,
            slug,
            name: names[slug] ?? slug,
            look: m.look,
            offline: !m.online,
          }));
        })
    : [];
  const open = (pc: string | null, slug: string) => {
    const tabs = readTabs(pc);
    if (!tabs.includes(slug)) store.set(tabKey(pc, "tabs"), JSON.stringify([...tabs, slug]));
    store.set(tabKey(pc, "project"), slug);
    store.set("ember.machine", pc ?? "");
    setMachine(pc);
  };
  const close = (pc: string | null, slug: string) => {
    store.set(tabKey(pc, "tabs"), JSON.stringify(readTabs(pc).filter((s) => s !== slug)));
    setTick((t) => t + 1);
  };
  const here = machines.find((m) => m.pc === current);

  if (here && !here.online) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg p-6 text-ink">
        <div
          className="max-w-md rounded-2xl border border-gold/30 bg-panel p-6"
          data-testid="war-room-pc-offline"
        >
          <h1 className="font-display text-[1.6rem]" style={{ color: here.look.color }}>
            {here.look.name} is offline
          </h1>
          <p className="mt-2 text-muted">
            Its projects come back here as soon as it is on and can reach your Hearth.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => {
                store.set("ember.machine", "");
                setMachine(null);
              }}
              className="min-h-10 rounded-lg border border-gold/50 px-4 text-gold hover:bg-gold/10"
            >
              Go to {machines[0]?.look.name ?? "your Hearth"}
            </button>
            <Link
              to="/"
              className="flex min-h-10 items-center rounded-lg border border-line px-4 text-muted hover:text-ink"
            >
              Back to Hearth
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <EmberRoom
      key={current ?? "hub"}
      pc={current}
      {...(here && (multi || here.look.src) ? { here: here.look } : {})}
      others={others}
      elsewhere={elsewhere}
      onMenu={() => void qc.invalidateQueries({ queryKey: ["engine-projects"] })}
      machines={machines}
      onOpenOther={open}
      onCloseOther={close}
      onTabs={() => setTick((t) => t + 1)}
    />
  );
}
